const RETENTION=7*86400000;
export const initialState=()=>({messages:[],booking:{first:null,last:null,phone:null,email:null,appointmentRequest:null,dateTimeKnown:false,requested:false,submitted:false,status:'collecting'},receipts:{}});
// Strong reads plus conditional writes protect against concurrent function instances.
export class SessionStore {
 constructor(blobs){this.blobs=blobs;}
 async read(key){return this.blobs.getWithMetadata(key,{type:'json',consistency:'strong'});}
 async write(key,data,previous){return this.blobs.setJSON(key,data,previous?{onlyIfMatch:previous.etag}:{onlyIfNew:true});}
 async rate(key,limit,window=60000){
  const id='limits/'+key;const now=Date.now();const bucket=Math.floor(now/window);
  for(let attempt=0;attempt<8;attempt++){
   const previous=await this.read(id);const count=previous?.data.window===bucket?previous.data.count:0;
   if(count>=limit)return false;
   const result=await this.write(id,{window:bucket,count:count+1,expires:now+window*2},previous);
   if(result.modified)return true;
  }
  return false;
 }
 async acquire(id){
  const key='sessions/'+id;
  for(let attempt=0;attempt<4;attempt++){
   const now=Date.now();const previous=await this.read(key);
   if(previous?.data.lockUntil>now)return null;
   const state=previous?.data.expires>now?previous.data.state:initialState();
   const token=crypto.randomUUID();const record={state,token,lockUntil:now+300000,expires:now+RETENTION};
   const result=await this.write(key,record,previous);
   if(result.modified)return {id,key,token,etag:result.etag,state:structuredClone(state),record:structuredClone(record)};
  }
  return null;
 }
 async save(lease){
  if(lease.record.lockUntil<=Date.now())throw new Error('Session lease expired');
  const record={...lease.record,state:structuredClone(lease.state),expires:Date.now()+RETENTION};
  const result=await this.blobs.setJSON(lease.key,record,{onlyIfMatch:lease.etag});
  if(!result.modified)throw new Error('Session lease lost');
  lease.etag=result.etag;lease.record=record;
 }
 async release(lease){
  // Only release the last successfully persisted state, never unsaved mutations.
  const result=await this.blobs.setJSON(lease.key,{...lease.record,token:null,lockUntil:0},{onlyIfMatch:lease.etag});
  if(result.modified)lease.etag=result.etag;
 }
 async purgeExpired(){
  let purged=0;
  for await(const page of this.blobs.list({prefix:'sessions/',paginate:true})){
   for(const {key} of page.blobs){
    const previous=await this.read(key);const now=Date.now();
    if(!previous||!previous.data.state||previous.data.expires>now||previous.data.lockUntil>now)continue;
    // CAS tombstones erase contact details without deleting a concurrently renewed session.
    const result=await this.write(key,{state:null,token:null,lockUntil:0,expires:0},previous);
    if(result.modified)purged++;
   }
  }
  return purged;
 }
}
