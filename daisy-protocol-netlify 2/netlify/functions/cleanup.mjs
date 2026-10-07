import {getStore} from '@netlify/blobs';
import {SessionStore} from '../../server/store.js';
export default async function cleanup(){
 const store=new SessionStore(getStore({name:'scheduling',consistency:'strong'}));
 await store.purgeExpired();
 return new Response(null,{status:204});
}
export const config={schedule:'17 3 * * *'};
