import {BookingAgent,ChatError} from './agent.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function body(req){const reader=req.body?.getReader();if(!reader)throw new ChatError('A JSON body is required.');let size=0;const chunks=[];try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>12000)throw new ChatError('Message is too large.',413);chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}try{return JSON.parse(new TextDecoder().decode(bytes))}catch{throw new ChatError('Invalid JSON.')}}
export async function handle(req,{config,store,ip='local',agent=new BookingAgent(config,store)}){
 const url=new URL(req.url);if(url.pathname==='/api/health'&&req.method==='GET')return json({ok:true});
 if(url.pathname!=='/api/chat')return json({error:'Not found.'},404);
 if(req.method!=='POST')return json({error:'Use POST /api/chat.'},405);
 if(req.headers.get('origin')&&req.headers.get('origin')!==url.origin)return json({error:'Please use the chat on this website.'},403);
 if(req.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json')return json({error:'Send JSON.'},415);
 try{
  const ipHash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(ip)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  if(!await store.rate('ip:'+ipHash,30)||!await store.rate('global',300))throw new ChatError('Too many messages. Please wait a minute.',429);
  const input=await body(req);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['sessionId','message','requestId'].includes(k)))throw new ChatError('Invalid request.');
  if(typeof input.sessionId!=='string'||!uuid.test(input.sessionId))throw new ChatError('A valid session ID is required.');
  if(typeof input.message!=='string'||!input.message.trim()||input.message.length>2000)throw new ChatError('Please enter a message of 1–2,000 characters.');
  if(input.requestId!==undefined&&(typeof input.requestId!=='string'||!uuid.test(input.requestId)))throw new ChatError('Invalid request ID.');
  if(!await store.rate('session:'+input.sessionId,12))throw new ChatError('Please wait a minute before sending more messages.',429);
  return json(await agent.chat({...input,message:input.message.trim(),requestId:input.requestId||crypto.randomUUID()}));
 }catch(error){return json({error:error instanceof ChatError?error.message:'The chat is temporarily unavailable. Please try again later.'},error instanceof ChatError?error.status:503)}
}
