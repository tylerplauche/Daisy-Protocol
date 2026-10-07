import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SessionStore} from '../server/store.js';
import {BookingAgent} from '../server/agent.js';
class FakeBlobs {
 rows=new Map();sequence=0;
 async getWithMetadata(key){return structuredClone(this.rows.get(key)||null)}
 async setJSON(key,data,options={}){
  const previous=this.rows.get(key);
  if(options.onlyIfNew&&previous||options.onlyIfMatch&&previous?.etag!==options.onlyIfMatch)return {modified:false};
  const etag=String(++this.sequence);this.rows.set(key,{data:structuredClone(data),etag});return {modified:true,etag};
 }
 async *list({prefix}){yield {blobs:[...this.rows.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key}))}}
}
test('concurrent instances acquire one lease; stale writes cannot overwrite renewed state',async()=>{
 const blobs=new FakeBlobs();const a=new SessionStore(blobs),b=new SessionStore(blobs);
 const leases=await Promise.all([a.acquire('same'),b.acquire('same')]);assert.equal(leases.filter(Boolean).length,1);
 const first=leases.find(Boolean);first.state.booking.submitted=true;await a.save(first);await a.release(first);
 const second=await b.acquire('same');assert.equal(second.state.booking.submitted,true);
 await assert.rejects(a.save(first),/lost/);await a.release(first);assert.equal(await a.acquire('same'),null);
 await b.release(second);
});
test('release preserves durable submitted marker after later save fails',async()=>{
 const blobs=new FakeBlobs();const store=new SessionStore(blobs);const lease=await store.acquire('crash');
 lease.state.booking.submitted=true;lease.state.booking.status='submitting';await store.save(lease);
 const real=blobs.setJSON.bind(blobs);blobs.setJSON=async()=>{throw new Error('storage down')};
 lease.state.booking.status='booked';await assert.rejects(store.save(lease));blobs.setJSON=real;await store.release(lease);
 const next=await new SessionStore(blobs).acquire('crash');assert.equal(next.state.booking.submitted,true);assert.equal(next.state.booking.status,'submitting');
});
test('conditional rate limits cannot exceed cap under concurrent calls',async()=>{
 const blobs=new FakeBlobs();const stores=Array.from({length:15},()=>new SessionStore(blobs));
 const accepted=await Promise.all(stores.map(s=>s.rate('global',3)));assert.equal(accepted.filter(Boolean).length,3);
});
test('retention erases expired contacts but preserves active leases',async()=>{
 const blobs=new FakeBlobs();const store=new SessionStore(blobs);const a=await store.acquire('expired');a.state.booking.email='test@example.com';await store.save(a);await store.release(a);
 blobs.rows.get('sessions/expired').data.expires=1;
 const b=await store.acquire('active');blobs.rows.get('sessions/active').data.expires=1;
 assert.equal(await store.purgeExpired(),1);assert.equal(blobs.rows.get('sessions/expired').data.state,null);assert.ok(blobs.rows.get('sessions/active').data.state);
 const fresh=await store.acquire('expired');assert.equal(fresh.state.booking.email,null);
});
test('n8n immediate acknowledgment and transport retries survive function instance changes',async()=>{
 const blobs=new FakeBlobs();let calls=0;
 const fields={first:'Test',last:'Visitor',phone:'8015550100',email:'test@example.com',appointmentRequest:'Friday at 2 PM'};
 const data={...fields,evidence:{...fields},dateTimeKnown:true,readyToBook:true,newBooking:false,reply:'What else?'};
 const config={apiKey:'mock',webhookUrl:'https://example.com/mock'};
 const options={extractFn:async()=>data,fetchImpl:async()=>{calls++;return Response.json({message:'Workflow was started'})}};
 const sessionId=crypto.randomUUID(),requestId=crypto.randomUUID();
 const input={sessionId,requestId,message:'Book Test Visitor 8015550100 test@example.com Friday at 2 PM'};
 const first=await new BookingAgent(config,new SessionStore(blobs),options).chat(input);assert.match(first.message,/submitted/);assert.equal(calls,1);
 const second=await new BookingAgent(config,new SessionStore(blobs),options).chat(input);assert.deepEqual(second,first);assert.equal(calls,1);
 const thanks=await new BookingAgent(config,new SessionStore(blobs),options).chat({...input,requestId:crypto.randomUUID(),message:'Thanks'});assert.match(thanks.message,/welcome/);assert.equal(calls,1);
});

test('hello gets a warm single question without a model call or a booking',async()=>{
 const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},new SessionStore(new FakeBlobs()),{extractFn:async()=>{throw new Error('Greeting should not call model')}});
 const reply=await agent.chat({sessionId:crypto.randomUUID(),requestId:crypto.randomUUID(),message:'hello'});
 assert.match(reply.message,/Hi there!/);assert.match(reply.message,/first name/);assert.doesNotMatch(reply.message,/last name|phone|email|confirmation/);assert.equal((reply.message.match(/\?/g)||[]).length,1);
});
for(const contact of [{email:'test@example.com',phone:null},{email:null,phone:'8015550100'},{email:'test@example.com',phone:'bad'}]){
 test('one valid contact is enough: '+JSON.stringify(contact),async()=>{
  const fields={first:'Test',last:'Visitor',appointmentRequest:'Friday at 2 PM',...contact};let payload;
  const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},new SessionStore(new FakeBlobs()),{
   extractFn:async()=>({...fields,evidence:{...fields},dateTimeKnown:true,readyToBook:true,newBooking:false,reply:'Please share both phone and email?'}),
   fetchImpl:async(url,init)=>{payload=JSON.parse(init.body);return Response.json({message:'Workflow was started'})}
  });
  const reply=await agent.chat({sessionId:crypto.randomUUID(),requestId:crypto.randomUUID(),message:'Book Test Visitor Friday at 2 PM '+Object.values(contact).filter(Boolean).join(' ')});
  assert.match(reply.message,/submitted/);assert.equal(payload.email,contact.email);assert.equal(payload.phone,contact.phone==='bad'?null:contact.phone);
 });
}
test('missing both contacts asks for a choice, not both; invalid fields do not submit',async()=>{
 let submitted=0;const fields={first:'Test',last:'Visitor',phone:'123',email:'bad',appointmentRequest:'Friday at 2 PM'};
 const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},new SessionStore(new FakeBlobs()),{extractFn:async()=>({...fields,evidence:{...fields},dateTimeKnown:true,readyToBook:true,newBooking:false,reply:'Give me phone and email?'}),fetchImpl:async()=>{submitted++;return Response.json({success:true})}});
 const reply=await agent.chat({sessionId:crypto.randomUUID(),requestId:crypto.randomUUID(),message:'Book Test Visitor Friday at 2 PM 123 bad'});
 assert.equal(submitted,0);assert.match(reply.message,/email address or phone number/);assert.match(reply.message,/Either one is fine/);
});
test('multi-field model demands fall back to only the next missing detail',async()=>{
 const fields={first:'Test',last:null,phone:null,email:null,appointmentRequest:null};
 const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},new SessionStore(new FakeBlobs()),{extractFn:async()=>({...fields,evidence:{...fields},dateTimeKnown:false,readyToBook:false,newBooking:false,reply:'Could you share last name, phone, email and date?'}),fetchImpl:async()=>{throw new Error('Not ready')}});
 const reply=await agent.chat({sessionId:crypto.randomUUID(),requestId:crypto.randomUUID(),message:'Test'});
 assert.equal(reply.message,'Nice to meet you! And your last name?');
});

test('PM alone cannot complete the appointment time or trigger a booking',async()=>{
 const blobs=new FakeBlobs(),store=new SessionStore(blobs);const id=crypto.randomUUID();const lease=await store.acquire(id);
 Object.assign(lease.state.booking,{first:'Test',last:'Visitor',phone:'8015550100',appointmentRequest:'tomorrow afternoon',requested:true,dateTimeKnown:false});await store.save(lease);await store.release(lease);
 let calls=0;const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},store,{extractFn:async()=>({first:null,last:null,phone:null,email:null,appointmentRequest:'tomorrow PM',evidence:{appointmentRequest:'pm'},dateTimeKnown:true,readyToBook:true,reply:'What email can I use?'}),fetchImpl:async()=>{calls++;return Response.json({success:true})}});
 const reply=await agent.chat({sessionId:id,requestId:crypto.randomUUID(),message:'pm'});
 assert.equal(calls,0);assert.match(reply.message,/What time/);assert.doesNotMatch(reply.message,/email/);
});
test('calendar event time is shown and status checks use only the read-only action',async()=>{
 const {appointmentReply}=await import('../server/agent.js');
 const store=new SessionStore(new FakeBlobs());const sessionId=crypto.randomUUID();const lease=await store.acquire(sessionId);
 Object.assign(lease.state.booking,{first:'Test',last:'Visitor',phone:'8015550100',appointmentRequest:'Friday 2 PM',submitted:true,status:'submitted',bookingReference:crypto.randomUUID()});await store.save(lease);await store.release(lease);
 const appointment={id:'event123',start:'2026-10-09T14:00:00-06:00',end:'2026-10-09T14:20:00-06:00',timeZone:'America/Denver'};const actions=[];
 const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},store,{extractFn:async()=>{throw new Error('No LLM needed for verification')},fetchImpl:async(url,init)=>{actions.push(JSON.parse(init.body));return Response.json({success:true,status:'confirmed',appointment})}});
 const reply=await agent.chat({sessionId,requestId:crypto.randomUUID(),message:'Can you check if the appointment is there and what time?'});
 assert.equal(reply.message,appointmentReply(appointment));assert.match(reply.message,/2:00 PM/);assert.equal(actions[0].action,'status');
 await agent.chat({sessionId,requestId:crypto.randomUUID(),message:'What time again?'});assert.equal(actions[1].eventId,'event123');assert.ok(actions.every(p=>p.action==='status'));
});
test('success prose without a calendar event cannot invent a time or confirm existence',async()=>{
 const {submit}=await import('../server/agent.js');
 const result=await submit({webhookUrl:'https://example.com/mock'},{first:'Test',last:'Visitor',phone:'8015550100',appointmentRequest:'Friday 2 PM'},async()=>Response.json({success:true,output:'Confirmed for 3 PM!'}));
 assert.equal(result.confirmed,false);assert.doesNotMatch(result.message,/3 PM/);
});
test('read-only lookup failure never rebooks or repeats a stale confirmation',async()=>{
 const {checkAppointment}=await import('../server/agent.js');let calls=0;
 const result=await checkAppointment({webhookUrl:'https://example.com/mock'},{first:'Test',last:'Visitor',email:'test@example.com',appointment:{id:'old',start:'2026-10-09T14:00:00-06:00'}},async(url,init)=>{calls++;assert.equal(JSON.parse(init.body).action,'status');return Response.json({success:false,status:'not_found'})});
 assert.equal(calls,1);assert.equal(result.appointment,null);assert.match(result.message,/couldn’t verify/);
});

test('multiple verified events are listed and an explicit selection is checked by ID',async()=>{
 const blobs=new FakeBlobs(),store=new SessionStore(blobs),sessionId=crypto.randomUUID();const lease=await store.acquire(sessionId);Object.assign(lease.state.booking,{first:'Test',last:'Visitor',phone:'8015550100',submitted:true,status:'submitted'});await store.save(lease);await store.release(lease);
 const appointments=[{id:'a',start:'2026-10-08T14:00:00-06:00',end:'2026-10-08T14:20:00-06:00',timeZone:'America/Denver'},{id:'b',start:'2026-10-09T15:00:00-06:00',end:'2026-10-09T15:20:00-06:00',timeZone:'America/Denver'}];const sent=[];
 const agent=new BookingAgent({apiKey:'mock',webhookUrl:'https://example.com/mock'},store,{fetchImpl:async(url,init)=>{const b=JSON.parse(init.body);sent.push(b);return Response.json(b.eventId?{success:true,status:'confirmed',appointment:appointments[1]}:{success:false,status:'ambiguous',appointments,matchCount:2})}});
 const list=await agent.chat({sessionId,requestId:crypto.randomUUID(),message:'Check my appointment'});assert.match(list.message,/2:00 PM/);assert.match(list.message,/3:00 PM/);
 const chosen=await agent.chat({sessionId,requestId:crypto.randomUUID(),message:'2'});assert.match(chosen.message,/confirmed/);assert.equal(sent[1].eventId,'b');assert.ok(sent.every(b=>b.action==='status'));
});
