import {FIELDS,limitedJson} from './openai.js';
export const validEmail=value=>typeof value==='string'&&value.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
export const validPhone=value=>typeof value==='string'&&/^[+\d\s().-]+$/.test(value)&&value.replace(/\D/g,'').length>=7&&value.replace(/\D/g,'').length<=15;
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
 if(data.readyToBook===true)next.requested=true;
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
export const bookingPayload=booking=>({action:'schedule',first:booking.first,last:booking.last,phone:validPhone(booking.phone)?booking.phone:null,email:validEmail(booking.email)?booking.email:null,message:booking.appointmentRequest,...(booking.bookingReference?{bookingReference:booking.bookingReference}: {})});
export async function bookingFingerprint(booking){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(bookingPayload(booking))));return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');}
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
