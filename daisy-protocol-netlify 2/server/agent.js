import {extract} from './openai.js';
import {mergeBooking,missing,hasSpecificTime,validEmail,validPhone,submit,checkAppointment} from './scheduling.js';
export * from './scheduling.js';
export class ChatError extends Error{constructor(message,status=400){super(message);this.status=status}}
// Model chooses conversational intent; deterministic code alone authorizes side effects.
export class BookingAgent {
 constructor(config,store,{extractFn=extract,fetchImpl=fetch}={}){this.config=config;this.store=store;this.extract=extractFn;this.fetch=fetchImpl;}
 async chat({sessionId,message,requestId}) {
  if(!this.config.apiKey)throw new ChatError('I’m having trouble connecting right now. Please try again in a moment.',503);
  const lease=await this.store.acquire(sessionId);
  if(!lease)throw new ChatError('Please wait for your previous message to finish.',409);
  const session=lease.state;
  const finish=async reply=>{
   if(typeof reply!=='string'||!reply.trim()||reply.length>8000)throw new ChatError('I’m having trouble responding right now. Please try again.',503);
   session.messages.push({role:'assistant',content:reply});session.receipts[requestId]=reply;
   for(const id of Object.keys(session.receipts).slice(0,-60))delete session.receipts[id];
   session.messages=session.messages.slice(-40);await this.store.save(lease);return {message:reply};
  };
  const model=async context=>{
   try{return await this.extract(this.config,{...session,responseContext:context},this.fetch)}
   catch(error){console.error('Chat model failure',{name:error?.name||'Error'});throw new ChatError('I’m having trouble connecting right now. Please try again in a moment.',503)}
  };
  try {
   if(lease.expired){const error=new ChatError('This conversation expired. Please start a new conversation.',409);error.code='SESSION_EXPIRED';throw error;}
   // An identical transport retry retrieves its receipt without a second model or calendar call.
   if(session.receipts[requestId])return {message:session.receipts[requestId]};
   session.lastActivityAt=Date.now();
   session.messages.push({role:'user',content:message});
   const data=await model(null);
   const wasSubmitted=session.booking.submitted;
   if(wasSubmitted&&data.newBooking&&data.intent==='scheduling'&&data.operation==='book'){
    const {first,last,phone,email}=session.booking;
    session.booking={first,last,phone,email,appointmentRequest:null,dateTimeKnown:false,requested:false,submitted:false,status:'collecting',timeEvidence:[]};
   }
   session.intent=data.intent;
   // Do not overwrite the identity or requested time of an already submitted event.
   if(!session.booking.submitted)session.booking=mergeBooking(session.booking,data,message);
   const booking=session.booking;
   if(!booking.submitted){
    booking.timeEvidence=[...(booking.timeEvidence||[]),{role:'user',content:message}].filter(m=>/\d|noon|midnight/i.test(m.content)).slice(-12);
    if(!hasSpecificTime(booking.appointmentRequest,[...booking.timeEvidence,...session.messages]))booking.dateTimeKnown=false;
   }
   if(data.intent==='general_chat'||data.intent==='other'||data.operation==='none'||data.operation==='manage')return await finish(data.reply);
   let context={intent:session.intent,missing:missing(booking),submitted:booking.submitted,calendar:null};
   if(data.operation==='check'){
    const needs=[];if(!booking.first)needs.push('first name');if(!booking.last)needs.push('last name');
    if(!validEmail(booking.email)&&!validPhone(booking.phone))needs.push('email or phone');
    context.missing=needs;
    if(!needs.length){
     const selected=Number.isInteger(data.selectedAppointment)?booking.candidates?.[data.selectedAppointment-1]:null;
     if(selected)booking.appointment=selected;
     try{
      const result=await checkAppointment(this.config,booking,this.fetch);
      booking.appointment=result.appointment;booking.candidates=result.candidates||[];
      if(booking.submitted)booking.status=result.appointment?'booked':'submitted';
      context.calendar={status:result.appointment?'confirmed':result.candidates?.length?'ambiguous':'not_found',appointment:result.appointment,candidates:booking.candidates,explanation:result.message};
     }catch(error){console.error('Calendar status failure',{name:error?.name||'Error'});context.calendar={status:'unknown',explanation:'The calendar could not be checked. No appointment was created or changed.'};}
    }
   }else if(data.operation==='book'&&data.intent==='scheduling'&&!booking.submitted&&!missing(booking).length){
    if(!this.config.webhookUrl)throw new ChatError('Appointment requests are temporarily unavailable. Please try again later.',503);
    // Save BEFORE dispatch. Ambiguous timeouts and crashes must never cause auto-resubmission.
    booking.bookingReference=crypto.randomUUID();booking.submitted=true;booking.status='submitting';await this.store.save(lease);
    try{
     const result=await submit(this.config,booking,this.fetch);
     booking.status=result.confirmed?'booked':'submitted';booking.appointment=result.appointment||null;
     context.calendar={status:result.confirmed?'confirmed':'pending',appointment:booking.appointment,explanation:result.message};
    }catch(error){console.error('Calendar submission failure',{name:error?.name||'Error'});booking.status='unknown';context.calendar={status:'unknown',explanation:'The request may have reached the business. It is not confirmed. Do not send another request.'};}
    // Persist the outcome before asking the model to explain it, so model failures are retry-safe.
    await this.store.save(lease);
   }else if(booking.submitted){
    context.calendar={status:booking.appointment?'previously_confirmed':booking.status,appointment:booking.appointment||null,explanation:'Already submitted. Do not send again. A fresh status check is available on request.'};
   }
   context.submitted=booking.submitted;
   const response=await model(context);
   return await finish(response.reply);
  }finally{await this.store.release(lease)}
 }
}
