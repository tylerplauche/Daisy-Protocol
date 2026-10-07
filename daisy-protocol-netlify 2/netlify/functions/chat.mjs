import {getStore} from '@netlify/blobs';
import {SessionStore} from '../../server/store.js';
import {handle} from '../../server/http.js';
export default async function chat(request,context){
 try{
  const config={apiKey:process.env.OPENAI_API_KEY||'',model:process.env.OPENAI_MODEL||'gpt-4.1-mini',webhookUrl:process.env.N8N_WEBHOOK_URL||''};
  if(config.webhookUrl&&!config.webhookUrl.startsWith('https://'))throw new Error('Public HTTPS webhook required');
  return await handle(request,{config,store:new SessionStore(getStore({name:'scheduling',consistency:'strong'})),ip:context.ip||'unknown'});
 }catch{return Response.json({error:'Scheduling is temporarily unavailable. Please try again later.'},{status:503,headers:{'Cache-Control':'no-store'}})}
}
export const config={path:'/api/chat'};
