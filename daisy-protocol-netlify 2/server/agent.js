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
export function missing(booking){const keys=[];if(!booking.first)keys.push('first name');if(!booking.last)keys.push('last name');if(!validPhone(booking.phone))keys.push('a valid phone number');if(!validEmail(booking.email))keys.push('a valid email address');if(!booking.appointmentRequest||!booking.dateTimeKnown)keys.push('the appointment date and time (including AM or PM)');if(!booking.requested)keys.push('confirmation that you want to book');return keys;}
function question(booking){const fields=missing(booking);if(fields.length===1&&fields[0]==='confirmation that you want to book')return 'Would you like me to book the appointment with these details?';return `Could you share ${fields.join(', ').replace(/, ([^,]*)$/,' and $1')}?`;}
function safeQuestion(reply,booking){
 // Only a concise question can be shown before a verified submission; never model confirmations.
 const needed=missing(booking);
 const asksForNeeded=needed.some(field=>field.includes('name')?/\bname\b/i.test(reply):field.includes('phone')?/\bphone|number\b/i.test(reply):field.includes('email')?/\bemail\b/i.test(reply):field.includes('date')?/\bdate|time|day|morning|afternoon|AM|PM\b/i.test(reply):/\bbook|schedule|confirm\b/i.test(reply));
 const q=reply?.trim();if(!asksForNeeded||!q||q.length>600||!q.endsWith('?')||/[.!\n]/.test(q.slice(0,-1))||/booked|confirmed|scheduled|reserved|available|availability|success|webhook|api|https?:|json|system prompt/i.test(q))return question(booking);
 // Prevent asking for fields already present even if the model forgets them.
 if((booking.first&&booking.last&&/\bname\b/i.test(q))||(validPhone(booking.phone)&&/\bphone\b/i.test(q))||(validEmail(booking.email)&&/\bemail\b/i.test(q)))return question(booking);
 return q;
}
export const bookingPayload=booking=>({action:'schedule',first:booking.first,last:booking.last,phone:booking.phone,email:booking.email,message:booking.appointmentRequest});
export async function bookingFingerprint(booking){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(bookingPayload(booking))));return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');}
export function submittedReply(booking,message){
 const text=message.toLowerCase();
 if(/\b(?:thanks|thank you|great|awesome|perfect)\b/.test(text))return 'You’re welcome! Let me know if you need help with anything else.';
 if(/\b(?:cancel|reschedule|change|move|make it|instead)\b/.test(text))return 'I haven’t changed or cancelled your appointment. Please contact the business to update the request already sent. I can also help you book a separate appointment.';
 const status=booking.status==='booked'?'Your appointment is confirmed.':booking.status==='submitted'?'Your appointment request was received, but I haven’t received a final booking confirmation.':'I can’t verify the outcome of your earlier request. Please check with the business before booking the same appointment again.';
 if(/\b(?:why|problem|error|stuck|failed|wrong)\b/.test(text))return status+' I’m keeping that request on record to avoid sending it twice. You can ask about it here or start a separate appointment.';
 if(/\b(?:retry|try again|send again|repeat)\b/.test(text))return status+' I won’t send a duplicate request.';
 if(/\b(?:hello|hi|hey)\b/.test(text))return 'Hi again! '+status+' How can I help?';
 if(/\b(?:when|next|email|confirmation|status|booked|submitted|appointment)\b/.test(text))return status+' For timing or changes, please contact the business directly.';
 return status+' I can explain the next steps or help you book another appointment. What would you like to do?';
}
export async function submit(config,booking,fetchImpl=fetch){
 const payload=bookingPayload(booking);
 const response=await fetchImpl(config.webhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000),redirect:'manual'});
 if(!response.ok)throw new Error('Booking endpoint failed');
 const raw=await limitedJson(response);const result=Array.isArray(raw)&&raw.length===1?raw[0]:raw;
 if(!result||typeof result!=='object'||Array.isArray(result)||result.success===false||result.error)throw new Error('Booking was not confirmed');
 const acknowledgment=typeof result.message==='string'&&/^workflow (?:was )?started[.!]?$/i.test(result.message.trim());
 if(acknowledgment)return {message:'Your appointment request has been submitted. I haven’t received a final booking confirmation yet. Please check with the business before making plans.',confirmed:false};
 // Prefer explicit success. A completed booking status is also supported without workflow changes.
 const success=result.success===true||['booked','confirmed','scheduled','success'].includes(result.status);
 const text=typeof result.output==='string'?result.output:typeof result.message==='string'?result.message:typeof result.reply==='string'?result.reply:typeof result.confirmation==='string'?result.confirmation:null;
 const safeText=text&&text.length<=2000&&!/https?:\/\/|webhook|api[_ -]?key|\bJSON\b|workflow (?:was )?started/i.test(text);
 if(!success&&!safeText)throw new Error('Booking outcome is unclear');
 // Existing n8n AI workflows commonly return {output: '...'} without a success flag.
 // Show their actual response, but do not invent a separate booked confirmation.
 return {message:safeText?text:'Your appointment has been confirmed. Thank you!',confirmed:success};
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
   if(wasSubmitted&&!explicitNew(message))return await finish(submittedReply(session.booking,message));
   let data;try{data=await this.extract(this.config,session,this.fetch)}catch(error){console.error('Scheduling response failed',JSON.stringify({name:error?.name||'Error',stage:['OpenAI request failed','Incomplete model response','Invalid model response','Empty upstream response','Upstream response too large'].includes(error?.message)?error.message:'transport_or_parse'}));session.messages.pop();throw new ChatError('I’m having trouble responding right now. Please try your message again.',503)}
   if(wasSubmitted){
    if(!data.newBooking)return await finish('Do you want to book a separate, additional appointment? Please say “book another appointment” to start one.');
    const previous=session.booking;session.booking={first:previous.first,last:previous.last,phone:previous.phone,email:previous.email,appointmentRequest:null,dateTimeKnown:false,requested:false,submitted:false,status:'collecting'};
   }
   session.booking=mergeBooking(session.booking,data,message);
   // Affirmation is valid only after the application's own explicit booking question.
   if(!session.booking.requested&&/^\s*(?:yes|yes please|please do|go ahead|confirm)[.!]?\s*$/i.test(message)&&session.messages.at(-2)?.content==='Would you like me to book the appointment with these details?')session.booking.requested=true;
   if(missing(session.booking).length)return await finish(safeQuestion(data.reply,session.booking));
   // Durable write BEFORE any network side effect: never automatically retry this request,
   // even on timeouts or process crashes. This is at-most-once delivery, not exactly-once receipt.
   session.booking.submitted=true;session.booking.status='submitting';await this.store.save(lease);
   let reply;try{const result=await submit(this.config,session.booking,this.fetch);reply=result.message;session.booking.status=result.confirmed?'booked':'submitted'}catch(error){console.error('Booking confirmation unavailable',JSON.stringify({name:error?.name||'Error',stage:['Booking endpoint failed','Booking was not confirmed','Booking outcome is unclear'].includes(error?.message)?error.message:'transport_or_response'}));session.booking.status='unknown';reply='There was a problem confirming your appointment. It may have reached the business, so please contact them before trying again. I haven’t marked it as booked.'}
   return await finish(reply);
  }finally{await this.store.release(lease)}
 }
}
