import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BookingAgent,submit} from '../server/agent.js';
import {initialState,SessionStore} from '../server/store.js';
import {extract} from '../server/openai.js';
import {businessContext,sessionTimeoutMs} from '../server/business.js';
import {freshSession,restoreSession,isExpired} from '../public/scheduling/chat-session.js';
class MemoryStore {
 state=initialState(); saves=[];
 async acquire(){return {state:structuredClone(this.state)}}
 async save(l){this.state=structuredClone(l.state);this.saves.push(structuredClone(this.state))}
 async release(){}
}
const config={apiKey:'mock',webhookUrl:'https://example.com/mock',business:businessContext({})};
const blank={first:null,last:null,phone:null,email:null,appointmentRequest:null,evidence:{},intent:'general_chat',operation:'none',selectedAppointment:null,dateTimeKnown:false,readyToBook:false,newBooking:false,reply:'Hello! How can I help?'};
const input=message=>({sessionId:crypto.randomUUID(),requestId:crypto.randomUUID(),message});
const details={first:'Boden',last:'Brooks',phone:'8015550100',email:null,appointmentRequest:'Friday at 2 PM'};
const booking={...blank,...details,evidence:{...details},intent:'scheduling',operation:'book',dateTimeKnown:true,readyToBook:true};
const event={id:'event123',start:'2026-10-09T14:00:00-06:00',end:'2026-10-09T14:20:00-06:00',timeZone:'America/Denver'};
for(const message of ['Hi','What services do you offer?','How does this work?','I need some help','Thanks']){
 test('normal conversation uses model and never webhook: '+message,async()=>{
  const store=new MemoryStore();let models=0;
  const agent=new BookingAgent(config,store,{extractFn:async()=>{models++;return {...blank,reply:'A contextual model answer.'}},fetchImpl:async()=>{throw Error('No webhook permitted')}});
  const r=await agent.chat(input(message));assert.equal(r.message,'A contextual model answer.');assert.equal(models,1);assert.equal(store.state.intent,'general_chat');
 });
}
test('volunteered name persists from general chat and is supplied on later scheduling turn',async()=>{
 const store=new MemoryStore();let call=0;
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>{
  call++;if(call===1)return {...blank,first:'Boden',last:'Brooks',evidence:{first:'Boden',last:'Brooks'}};
  assert.equal(s.booking.first,'Boden');assert.equal(s.booking.last,'Brooks');
  return {...blank,intent:'scheduling',operation:'book',reply:'What day works for you?'};
 },fetchImpl:async()=>{throw Error('Not ready')}});
 await agent.chat(input('Hi, I’m Boden Brooks'));const r=await agent.chat(input('Can someone see me next week?'));assert.equal(r.message,'What day works for you?');
});
test('leaving scheduling answers normally, preserving details for a return',async()=>{
 const store=new MemoryStore();Object.assign(store.state.booking,{first:'Boden',last:'Brooks',appointmentRequest:'Friday afternoon'});
 const agent=new BookingAgent(config,store,{extractFn:async()=>({...blank,reply:'Our hours haven’t been provided here.'}),fetchImpl:async()=>{throw Error('No webhook')}});
 assert.match((await agent.chat(input('Never mind. What are your hours?'))).message,/hours/);assert.equal(store.state.booking.first,'Boden');assert.equal(store.state.intent,'general_chat');
});
for(const contact of [{phone:'8015550100',email:null},{email:'boden@example.com',phone:null}]){
 test('one contact allows one authorized submission: '+Object.keys(contact)[0],async()=>{
  const store=new MemoryStore();let calls=0;let models=0;
  const d={...details,...contact};
  const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>{models++;return s.responseContext?{...blank,reply:s.responseContext.calendar?.status==='confirmed'?'Your consultation is confirmed for Friday, October 9 at 2 PM MDT.':'Happy to help.'}:{...booking,...d,evidence:{...d}}},fetchImpl:async(u,init)=>{calls++;assert.equal(store.state.booking.submitted,true);assert.equal(JSON.parse(init.body).action,'schedule');return Response.json({success:true,status:'confirmed',appointment:event})}});
  const req=input('Book Boden Brooks Friday at 2 PM '+Object.values(contact).filter(Boolean).join(' '));
  const r=await agent.chat(req);assert.match(r.message,/2(?::00)? PM MDT/);await agent.chat(req);assert.equal(calls,1);assert.equal(models,2);
  await agent.chat(input('Thanks'));assert.equal(calls,1);
 });
}
test('PM alone stays incomplete even if model extracts a fabricated hour',async()=>{
 const store=new MemoryStore();Object.assign(store.state.booking,{...details,appointmentRequest:'tomorrow afternoon',requested:true});
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>{
  if(s.responseContext){assert.ok(s.responseContext.missing.includes('appointment date and time'));return {...blank,reply:'What time in the afternoon works for you?'}}
  return {...blank,intent:'scheduling',operation:'book',appointmentRequest:'tomorrow at 3 PM',evidence:{appointmentRequest:'PM'},dateTimeKnown:true,readyToBook:true};
 },fetchImpl:async()=>{throw Error('Must not submit')}});
 assert.match((await agent.chat(input('PM'))).message,/What time/);assert.equal(store.state.booking.submitted,false);
});
test('availability question is not booking authorization',async()=>{
 const store=new MemoryStore();const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>s.responseContext?{...blank,reply:'Would you like to request that time?'}:{...booking,readyToBook:false},fetchImpl:async()=>{throw Error('Availability inquiry is not a booking')}});
 await agent.chat(input('Do you have Friday at 2 PM for Boden Brooks 8015550100?'));assert.equal(store.state.booking.submitted,false);
});
test('status check works in a fresh conversation, uses OpenAI, and never creates an event',async()=>{
 const store=new MemoryStore();let models=0;let actions=[];
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>{models++;if(s.responseContext){assert.equal(s.responseContext.calendar.appointment.id,event.id);return {...blank,reply:'Your appointment is Friday at 2 PM MDT.'}}return {...booking,intent:'checking_appointment',operation:'check',appointmentRequest:null}},fetchImpl:async(u,init)=>{actions.push(JSON.parse(init.body).action);return Response.json({success:true,status:'confirmed',appointment:event})}});
 assert.match((await agent.chat(input('Check my appointment. Boden Brooks 8015550100'))).message,/2(?::00)? PM/);assert.deepEqual(actions,['status']);assert.equal(models,2);assert.equal(store.state.booking.submitted,false);
});
test('rescheduling never triggers create or status webhook',async()=>{
 const store=new MemoryStore();store.state.booking.submitted=true;
 const agent=new BookingAgent(config,store,{extractFn:async()=>({...blank,intent:'scheduling',operation:'manage',reply:'I can’t change that appointment here.'}),fetchImpl:async()=>{throw Error('No changes permitted')}});
 assert.match((await agent.chat(input('Move my appointment to tomorrow'))).message,/can’t change/);assert.equal(store.state.booking.submitted,true);
});
test('pending result and retry cannot become verified from model prose or success flag',async()=>{
 const r=await submit(config,details,async()=>Response.json({success:true,output:'Confirmed for 3 PM'}));assert.equal(r.confirmed,false);
 const store=new MemoryStore();let submissions=0;let fail=true;
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>{if(s.responseContext){if(fail){fail=false;throw Error('model down')}assert.equal(s.responseContext.submitted,true);return {...blank,reply:'The request is awaiting confirmation.'}}return booking},fetchImpl:async()=>{submissions++;return Response.json({message:'Workflow started'})}});
 const req=input('Book Boden Brooks Friday at 2 PM 8015550100');await assert.rejects(agent.chat(req));await agent.chat(req);assert.equal(submissions,1);assert.equal(store.state.booking.submitted,true);
});
test('ambiguity retains choices and a model-understood selection checks only its event ID',async()=>{
 const store=new MemoryStore();Object.assign(store.state.booking,{...details,submitted:true});let phase=0;let ids=[];
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>s.responseContext?{...blank,reply:s.responseContext.calendar.explanation}:{...blank,intent:'checking_appointment',operation:'check',selectedAppointment:phase?2:null},fetchImpl:async(u,init)=>{ids.push(JSON.parse(init.body).eventId);return Response.json(phase?{success:true,status:'confirmed',appointment:event}:{status:'ambiguous',appointments:[{...event,id:'first'},event],matchCount:2})}});
 await agent.chat(input('Do I have an appointment?'));phase=1;await agent.chat(input('The later one, second on that list'));assert.deepEqual(ids,[undefined,'event123']);
});
test('new booking explicitly resets submitted state; ordinary thanks does not',async()=>{
 const store=new MemoryStore();Object.assign(store.state.booking,{...details,submitted:true,status:'booked'});
 const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>s.responseContext?{...blank,reply:'What day works for the separate appointment?'}:{...blank,intent:'scheduling',operation:'book',newBooking:true},fetchImpl:async()=>{throw Error('Not enough new information')}});
 await agent.chat(input('I’d like a separate consultation'));assert.equal(store.state.booking.submitted,false);assert.equal(store.state.booking.appointmentRequest,null);assert.equal(store.state.booking.first,'Boden');
});
test('browser sessions restore under timeout; expired and legacy sessions get new IDs',()=>{
 const s=freshSession(1000);s.messages.push({role:'user',content:'Hi'});assert.equal(restoreSession(s,1800000,1001).sessionId,s.sessionId);
 assert.notEqual(restoreSession(s,1800000,1801000).sessionId,s.sessionId);assert.equal(isExpired(s,1800000,1801000),true);
 assert.notEqual(restoreSession({...s,lastActivityAt:undefined},1800000,1001).sessionId,s.sessionId);assert.notEqual(freshSession().sessionId,s.sessionId);
});
test('backend rejects stale conversation, clears temporary contact and booking state',async()=>{
 let row=null;let n=0;const blobs={getWithMetadata:async()=>structuredClone(row),setJSON:async(k,data)=>{row={data:structuredClone(data),etag:String(++n)};return {modified:true,etag:row.etag}}};
 const store=new SessionStore(blobs,{timeoutMs:60000});const l=await store.acquire('old');l.state.lastActivityAt=Date.now()-60001;l.state.booking.phone='8015550100';l.state.booking.submitted=true;await store.save(l);await store.release(l);
 const agent=new BookingAgent(config,store,{extractFn:async()=>{throw Error('Expired')}});await assert.rejects(agent.chat({...input('hello'),sessionId:'old'}),e=>e.code==='SESSION_EXPIRED');assert.equal(row.data.state.booking.phone,null);assert.equal(row.data.state.booking.submitted,false);
});
test('OpenAI receives bounded history, durable state, business context and structured intent',async()=>{
 let sent;const session=initialState();session.booking.first='Boden';session.messages=Array.from({length:100},()=>({role:'user',content:'Hello'}));
 const result=await extract(config,session,async(u,init)=>{sent=JSON.parse(init.body);return Response.json({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(blank)}]}]})});
 assert.equal(sent.input.length,41);assert.match(sent.input[0].content,/Boden/);assert.match(sent.input[0].content,/Daisy Protocol/);assert.equal(result.intent,'general_chat');assert.equal(sent.store,false);
});
test('configuration uses one place and safely defaults timeout',()=>{
 assert.equal(businessContext({BUSINESS_NAME:'Example'}).name,'Example');assert.equal(sessionTimeoutMs('45'),2700000);assert.equal(sessionTimeoutMs('-1'),1800000);
});

test('unverified calendar result overrides an invented model confirmation',async()=>{
 const store=new MemoryStore();const agent=new BookingAgent(config,store,{extractFn:async(c,s)=>s.responseContext?{...blank,reply:'Your appointment is confirmed at 9 AM.'}:booking,fetchImpl:async()=>Response.json({message:'Workflow started'})});
 const r=await agent.chat(input('Book Boden Brooks Friday at 2 PM 8015550100'));
 assert.doesNotMatch(r.message,/confirmed at 9/);assert.match(r.message,/hasn’t confirmed/);
});
