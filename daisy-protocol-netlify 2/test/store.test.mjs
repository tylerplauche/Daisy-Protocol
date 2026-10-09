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
