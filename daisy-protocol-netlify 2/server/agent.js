import {extract,FIELDS,limitedJson} from './openai.js';
export class ChatError extends Error{constructor(message,status=400){super(message);this.status=status}}
export const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validPhone=value=>typeof value==='string'&&/^[+\d\s().-]+$/.test(value)&&value.replace(/\D/g,'').length>=7&&value.replace(/\D/g,'').length<=15;
const explicitNew=text=>/\b(?:another|additional|new|second|separate)\s+(?:\w+\s+){0,2}(?:appointment|booking)\b/i.test(text);
const bookingIntent=text=>/\b(?:book|schedule|appointment|booking)\b/i.test(text)||/\b(?:i(?:'d| would)? (?:like|need|want)|can i (?:get|have))\b/i.test(text);
export function mergeBooking(previous,data,message){
 const next={...previous};
 for(const key of FIELDS){const value=data[key],proof=data.evidence?.[key];if(value===null||typeof value!=='string'||!value.trim()||value.length>(key==='appointmentRequest'?1200:254))continue;
  if(typeof proof!=='string'||!proof.trim()||!message.includes(proof))continue;
  // Identity/contact values must appear in the actual user text, not merely in model JSON.
  if(key!=='appointmentRequest'){
   const normalize=s=>key==='phone'?s.replace(/\D/g,''):s.toLocaleLowerCase().trim();
   if(!normalize(proof).includes(normalize(value)))continue;
  }
  next[key]=value.trim();if(key==='appointmentRequest')next.dateTimeKnown=data.dateTimeKnown===true;
 }
 if(data.readyToBook&&bookingIntent(message))next.requested=true;
 return next;
}
// Require an actual clock time in the request, grounded in the user's words.
export function hasSpecificTime(request,messages=[]){
 const pattern=/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
 const times=[...String(request||'').matchAll(pattern)];
 if(!times.length)return false;
 const users=messages.filter(m=>m.role==='user').map(m=>m.content);
 const candidates=[];
 for(const content of users){
  for(const t of content.matchAll(pattern))candidates.push({hour:Number(t[1]||t[4]),minute:t[2]||t[5]||'00',period:t[3]?.replace(/\./g,'').toLowerCase()||null});
  for(const t of content.matchAll(/\bat\s+(1[0-2]|0?[1-9])(?::([0-5]\d))?\b(?!\s*[ap]\.?m)/gi))candidates.push({hour:Number(t[1]),minute:t[2]||'00',period:null});
  const bare=content.trim().match(/^(1[0-2]|0?[1-9])(?::([0-5]\d))?[.!]?$/);
  if(bare)candidates.push({hour:Number(bare[1]),minute:bare[2]||'00',period:null});
 }
 return times.some(t=>{
  const hour=Number(t[1]||t[4]),minute=t[2]||t[5]||'00',period=t[3]?.replace(/\./g,'').toLowerCase()||null;
  return candidates.some(c=>(c.hour%12)===(hour%12)&&c.minute===minute&&(!c.period||!period||c.period===period));
 });
}
export function appointmentTime(appointment){return new Intl.DateTimeFormat('en-US',{timeZone:appointment.timeZone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(appointment.start));}
export function appointmentReply(appointment){
 const date=new Date(appointment.start);
 return 'Your appointment is confirmed for '+new Intl.DateTimeFormat('en-US',{timeZone:appointment.timeZone,weekday:'long',month:'long',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(date)+'.';
}
export function verifiedAppointment(result){
 const a=result?.appointment;
 if(result?.success!==true||result?.status!=='confirmed'||!a||typeof a.id!=='string'||!a.id||typeof a.start!=='string'||typeof a.end!=='string')return null;
 const iso=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
 if(!iso.test(a.start)||!iso.test(a.end)||!Number.isFinite(Date.parse(a.start))||Date.parse(a.end)<=Date.parse(a.start))return null;
 const timeZone=a.timeZone||'America/Denver';try{new Intl.DateTimeFormat('en-US',{timeZone}).format()}catch{return null}
 return {id:a.id,start:a.start,end:a.end,timeZone};
}
export function missing(booking){
 const keys=[];
 if(!booking.first)keys.push('first name');
 if(!booking.last)keys.push('last name');
 if(!booking.appointmentRequest||!booking.dateTimeKnown)keys.push('appointment date and time');
 if(!validPhone(booking.phone)&&!validEmail(booking.email))keys.push('email or phone');
 if(!booking.requested)keys.push('booking confirmation');
 return keys;
}
export function question(booking,previous={}){
 if(!booking.first)return 'Happy to help. What’s your first name?';
 if(!booking.last)return previous.first!==booking.first?'Nice to meet you! And your last name?':'What’s your last name?';
 if(!booking.appointmentRequest)return 'What day would work well for you?';
 if(!booking.dateTimeKnown)return /pm|afternoon/i.test(booking.appointmentRequest||'')?'What time in the afternoon would work for you?':'What time works for you? Please include AM or PM.';
 if(!validPhone(booking.phone)&&!validEmail(booking.email)){
  if(booking.phone||booking.email)return 'That contact detail doesn’t look quite right. Could you share an email address or phone number? Either one is fine.';
  return 'What’s the best email address or phone number to reach you? Just one is fine.';
 }
 return 'Would you like me to book the appointment with these details?';
}
function safeQuestion(reply,booking,previous){
 const fallback=question(booking,previous),q=reply?.trim();
 // A friendly acknowledgment is welcome, but the model may ask about only
 // the next missing topic and may never assert availability or a booking.
 const topic=missing(booking)[0];
 if(topic==='email or phone'||topic==='booking confirmation')return fallback;
 if(!q||q.length>240||!q.endsWith('?')||(q.match(/\?/g)||[]).length!==1||/booked|confirmed|scheduled|reserved|available|availability|success|webhook|api|https?:|json|system prompt|\n/i.test(q))return fallback;
 const name=/\bname\b/i.test(q),contact=/\bemail|phone|contact|number\b/i.test(q),timing=/\bdate|time|day|morning|afternoon|AM|PM\b/i.test(q);
 if(topic==='first name'&&(!name||contact||timing||/last|full|surname|family/i.test(q)))return fallback;
 if(topic==='last name'&&(!name||contact||timing||/first|full/i.test(q)))return fallback;
 if(topic==='appointment date and time'&&(!timing||name||contact))return fallback;
 return q;
}
export const bookingPayload=booking=>({action:'schedule',first:booking.first,last:booking.last,phone:validPhone(booking.phone)?booking.phone:null,email:validEmail(booking.email)?booking.email:null,message:booking.appointmentRequest,...(booking.bookingReference?{bookingReference:booking.bookingReference}: {})});
export async function bookingFingerprint(booking){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(bookingPayload(booking))));return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function submittedReply(booking,message){
 const text=message.toLowerCase();
 if(/\b(?:thanks|thank you|great|awesome|perfect)\b/.test(text))return 'You’re welcome! Let me know if you need help with anything else.';
 if(/\b(?:cancel|reschedule|change|move|make it|instead)\b/.test(text))return 'I haven’t changed or cancelled your appointment. Please contact the business to update the request already sent. I can also help you book a separate appointment.';
 const status=booking.status==='booked'?(booking.appointment?appointmentReply(booking.appointment):'Your appointment is confirmed.'):booking.status==='submitted'?'Your appointment request was received, but I haven’t received a final booking confirmation.':'I can’t verify the outcome of your earlier request. Please check with the business before booking the same appointment again.';
 if(/\b(?:why|problem|error|stuck|failed|wrong)\b/.test(text))return status+' I’m keeping that request on record to avoid sending it twice. You can ask about it here or start a separate appointment.';
 if(/\b(?:retry|try again|send again|repeat)\b/.test(text))return status+' I won’t send a duplicate request.';
 if(/\b(?:hello|hi|hey)\b/.test(text))return 'Hi again! '+status+' How can I help?';
 if(/\b(?:when|next|email|confirmation|status|booked|submitted|appointment)\b/.test(text))return status+' For timing or changes, please contact the business directly.';
 return status+' I can explain the next steps or help you book another appointment. What would you like to do?';
}
async function webhook(config,payload,fetchImpl){
 const response=await fetchImpl(config.webhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(25000),redirect:'manual'});
 if(!response.ok)throw new Error('Booking endpoint failed');
 const raw=await limitedJson(response);const result=Array.isArray(raw)&&raw.length===1?raw[0]:raw;
 if(!result||typeof result!=='object'||Array.isArray(result))throw new Error('Invalid calendar response');
 return result;
}
export async function submit(config,booking,fetchImpl=fetch){
 const result=await webhook(config,bookingPayload(booking),fetchImpl);
 const appointment=verifiedAppointment(result);
 if(appointment)return {message:appointmentReply(appointment),confirmed:true,appointment};
 if(result.error)throw new Error('Booking was not confirmed');
 // Acknowledgments and model prose are not proof of an actual calendar event.
 return {message:'I’ve submitted your appointment request, but the calendar hasn’t confirmed a time yet. You can ask me to check its status in a moment.',confirmed:false};
}
export async function checkAppointment(config,booking,fetchImpl=fetch){
 const payload={...bookingPayload(booking),action:'status',...(booking.appointment?.id?{eventId:booking.appointment.id}:{})};
 const result=await webhook(config,payload,fetchImpl);const appointment=verifiedAppointment(result);
 const candidates=result.status==='ambiguous'&&Array.isArray(result.appointments)?result.appointments.map(a=>verifiedAppointment({success:true,status:'confirmed',appointment:a})).filter(Boolean).slice(0,5):[];
 if(candidates.length)return {appointment:null,candidates,message:'I found '+(result.matchCount||candidates.length)+' matching appointments in the calendar: '+candidates.map((a,i)=>(i+1)+') '+appointmentTime(a)).join('; ')+'. Which one did you mean? You can reply with its number.'};
 if(appointment)return {appointment,message:appointmentReply(appointment)};
 return {appointment:null,message:result.status==='ambiguous'?'I found more than one matching appointment, so I can’t identify the right one yet. Please check with the business. I haven’t created another appointment.':'I couldn’t verify that appointment in the calendar yet. It may still be processing. You can ask me to check again; I won’t submit it a second time.'};
}
export class BookingAgent{
 constructor(config,store,{extractFn=extract,fetchImpl=fetch}={}){this.config=config;this.store=store;this.extract=extractFn;this.fetch=fetchImpl;}
 async chat({sessionId,message,requestId}){
  if(!this.config.apiKey||!this.config.webhookUrl)throw new ChatError('Scheduling is temporarily unavailable. Please try again later.',503);
  const lease=await this.store.acquire(sessionId);if(!lease)throw new ChatError('Please wait for your previous message to finish.',409);
  const session=lease.state;
  const finish=async(reply)=>{session.messages.push({role:'assistant',content:reply});session.receipts[requestId]=reply;const ids=Object.keys(session.receipts);for(const id of ids.slice(0,-60))delete session.receipts[id];session.messages=session.messages.slice(-60);await this.store.save(lease);return {message:reply};};
  try{
   // Reconcile only payloads independently verified in n8n's existing execution records.
   if(session.booking.submitted&&session.booking.status==='unknown'&&(this.config.confirmedRequestHashes||[]).includes(await bookingFingerprint(session.booking))){session.booking.status='booked';return await finish('Your appointment was confirmed by the calendar. The earlier warning was incorrect; your request has not been sent again.')}
   if(session.receipts[requestId])return {message:session.receipts[requestId]};
   session.messages.push({role:'user',content:message});
   const wasSubmitted=session.booking.submitted;
   if(wasSubmitted&&!explicitNew(message)){
    const choice=message.trim().toLowerCase().replace(/[.!]/g,'');
    const index=/^[1-5]$/.test(choice)?Number(choice)-1:['first','second','third','fourth','fifth'].indexOf(choice.replace(/^(?:the )?/, '').replace(/ one$/, ''));
    const selected=session.booking.candidates?.[index];
    if(selected)session.booking.appointment=selected;
    if((selected||/\b(?:check|confirm|when|time|status|appointment|booked|there|scheduled)\b/i.test(message))&&!/\b(?:cancel|reschedule|change|move)\b/i.test(message)){
     try{const result=await checkAppointment(this.config,session.booking,this.fetch);session.booking.appointment=result.appointment;session.booking.candidates=result.candidates||[];session.booking.status=result.appointment?'booked':'submitted';return await finish(result.message)}
     catch{return await finish('I’m having trouble checking the calendar right now. Your earlier request is still on record, and I haven’t sent it again. Please try asking me to check in a moment.')}
    }
    return await finish(submittedReply(session.booking,message));
   }
   if(!wasSubmitted&&/^\s*(?:hi|hello|hey|good morning|good afternoon|good evening)[!.,\s]*$/i.test(message))return await finish(session.booking.first?question(session.booking,session.booking):'Hi there! I’d be happy to help you book a free consultation. What’s your first name?');
   const previousBooking={...session.booking};
   let data;try{data=await this.extract(this.config,session,this.fetch)}catch(error){console.error('Scheduling response failed',JSON.stringify({name:error?.name||'Error',stage:['OpenAI request failed','Incomplete model response','Invalid model response','Empty upstream response','Upstream response too large'].includes(error?.message)?error.message:'transport_or_parse'}));session.messages.pop();throw new ChatError('I’m having trouble responding right now. Please try your message again.',503)}
   if(wasSubmitted){
    if(!data.newBooking)return await finish('Do you want to book a separate, additional appointment? Please say “book another appointment” to start one.');
    const previous=session.booking;session.booking={first:previous.first,last:previous.last,phone:previous.phone,email:previous.email,appointmentRequest:null,dateTimeKnown:false,requested:false,submitted:false,status:'collecting'};
   }
   session.booking=mergeBooking(session.booking,data,message);
   if(!hasSpecificTime(session.booking.appointmentRequest,session.messages))session.booking.dateTimeKnown=false;
   // Affirmation is valid only after the application's own explicit booking question.
   if(!session.booking.requested&&/^\s*(?:yes|yes please|please do|go ahead|confirm)[.!]?\s*$/i.test(message)&&session.messages.at(-2)?.content==='Would you like me to book the appointment with these details?')session.booking.requested=true;
   if(missing(session.booking).length)return await finish(safeQuestion(data.reply,session.booking,previousBooking));
   // Durable write BEFORE any network side effect: never automatically retry this request,
   // even on timeouts or process crashes. This is at-most-once delivery, not exactly-once receipt.
   session.booking.bookingReference=crypto.randomUUID();session.booking.submitted=true;session.booking.status='submitting';await this.store.save(lease);
   let reply;try{const result=await submit(this.config,session.booking,this.fetch);reply=result.message;session.booking.status=result.confirmed?'booked':'submitted';session.booking.appointment=result.appointment||null}catch(error){console.error('Booking confirmation unavailable',JSON.stringify({name:error?.name||'Error',stage:['Booking endpoint failed','Booking was not confirmed','Booking outcome is unclear'].includes(error?.message)?error.message:'transport_or_response'}));session.booking.status='unknown';reply='There was a problem confirming your appointment. It may have reached the business, so please contact them before trying again. I haven’t marked it as booked.'}
   return await finish(reply);
  }finally{await this.store.release(lease)}
 }
}
