import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionRegistry, sessionEventCount } from '../packages/producer-core/src/index.ts';
import { verifyRecord } from '../packages/format/src/index.ts';
import { uploadJournal } from '../packages/browser-storage/src/upload.ts';

const origin = { origin:'https://example.test', path:'/', tab_id:1, frame_id:0 };
const descriptor = { tag_name:'TEXTAREA',field_kind:'textarea',name:null,id:null,aria_label:null,nearest_form_id:null,dom_signature:'test',index_among_similar:0 };
function setup({ retain = true, checkpoint } = {}) {
  const metadata = new Map(), events = new Map();
  let count = 0, now = 0, fail = false, maxBatch = 0, commits = 0;
  const storage = { read:async()=>structuredClone([...metadata.values()]), write:async()=>assert.fail('snapshot hot path'), journal:{
    async commit(batch) {
      if (fail) throw new Error('disk full');
      commits++;
      for (const id of batch.deleted) {metadata.delete(id);events.delete(id);}
      for (const id of batch.clear_events) events.delete(id);
      for (const append of batch.appends) {
        maxBatch = Math.max(maxBatch, append.events.length);
        if (retain) {
          const rows = events.get(append.session_id) ?? [];
          for (const event of append.events) { assert.equal(event.seq, rows.length); rows.push({...event}); }
          events.set(append.session_id,rows);
        }
        count += append.events.length;
      }
      for (const session of batch.sessions) {assert.equal(session.events.length,0);metadata.set(session.session_id,structuredClone(session));}
    },
    async readEvents(id,start,limit) { return structuredClone((events.get(id)??[]).slice(start,start+limit)); }
  }};
  let uuid = 0;
  const options = {storage,clock:{now:()=>now},uuid:{uuid:()=>`00000000-0000-4000-8000-${String(++uuid).padStart(12,'0')}`},producer:{id:'test',version:'1',capabilities:['timing']},signedFinishTime:true,checkpoint};
  const registry = new SessionRegistry(options);
  const create = () => registry.findOrCreate(origin,descriptor,{surface:'web-draft'},{fresh:true});
  return {registry,storage,options,create,metadata,events,setNow:value=>now=value,setFail:value=>fail=value,stats:()=>({count,maxBatch,commits})};
}
const mutation = {op:'insert',pos:null,ins_len:1,del_len:0,source:'typing'};

for (const resume of ['next edit', 'finish flush']) {
  test(`checkpointing resumes after a coalesced journal save fails: ${resume}`, async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const calls = [];
    const h = setup({ checkpoint: {
      async postCheckpoint(request) {
        calls.push(request);
        if (calls.length === 1) await pending;
        return { ok: true, response: {
          ...request, token: 't'.repeat(32), checkpoint_id: `cp-${calls.length}`,
          server_t: '2026-09-25T00:00:00.000Z',
        } };
      },
    } });
    const { session_id: id } = h.create();
    await h.registry.persist();
    h.registry.appendMutation(id, mutation);
    h.registry.appendMutation(id, mutation);
    h.setFail(true);
    release();
    await h.registry.awaitObservationIdle(id);
    assert.equal(calls.length, 1);
    assert.equal(h.registry.get(id).observation.in_flight, false);
    assert.equal(h.registry.get(id).observation.queued, true);
    h.setFail(false);
    await h.registry.persist();
    assert.equal(h.metadata.get(id).observation.in_flight, false);
    assert.equal(h.events.get(id).length, 2);
    if (resume === 'next edit') {
      // No new 50-event/60-second cadence interval is needed for queued work.
      h.registry.appendMutation(id, mutation);
      await h.registry.awaitObservationIdle(id);
    } else {
      h.registry.sign(id);
      await h.registry.persist();
      await h.registry.flushObservation(id);
    }
    assert.equal(calls.length, 2);
    assert.equal(calls[1].token, 't'.repeat(32));
    assert.equal(calls[1].observed_session_id, calls[0].observed_session_id);
    assert.equal(calls[1].event_count, resume === 'next edit' ? 3 : 2);
    assert.equal(h.registry.get(id).observation.state, 'known');
    assert.equal(h.registry.get(id).observation.in_flight, false);
    assert.equal(h.registry.get(id).observation.queued, false);
  });
}

test('journal append/sign/restart uses metadata-only reads and exact frozen publication', async()=>{
 const h=setup();const session=h.create();
 for(let i=0;i<10000;i++){ h.setNow(i*7);h.registry.appendMutation(session.session_id,mutation,{snapshot:false});if(i%128===127)await h.registry.persist();}
 h.setNow(2*365*24*3600*1000);
 const draft=h.registry.sign(session.session_id);await h.registry.persist();
 assert.equal(draft.events.length,0);assert.equal(draft.manifest.event_count,10000);assert.equal(draft.manifest.duration_ms,2*365*24*3600*1000);
 assert.ok(verifyRecord({manifest:draft.manifest,events:h.events.get(session.session_id)}).valid);
 const recovered=new SessionRegistry(h.options);await recovered.init();
 assert.equal(recovered.get(session.session_id).state,'failed_upload');
 assert.deepEqual(recovered.sign(session.session_id),draft);
 assert.equal(recovered.list()[0].events.length,0);
 assert.equal((await recovered.readEvents(session.session_id,8192,1808)).length,1808);
 assert.ok(h.stats().maxBatch<=128);
});

test('journal retains failed appends and rejects bounded backlog before modifying the chain',async()=>{
 const h=setup();const {session_id:id}=h.create();await h.registry.persist();h.setFail(true);
 for(let i=0;i<4096;i++) h.registry.appendMutation(id,mutation,{snapshot:false});
 await assert.rejects(h.registry.persist(),/disk full/);
 const before=h.registry.get(id);assert.throws(()=>h.registry.appendMutation(id,mutation),/cannot keep up|pending|saving|4096/);assert.deepEqual(h.registry.get(id),before);
 h.setFail(false);await h.registry.persist();assert.equal(h.events.get(id).length,4096);
 h.registry.appendMutation(id,mutation);await h.registry.persist();assert.equal(h.events.get(id).length,4097);
});

test('one million events retain a bounded append cache and metadata size',async()=>{
 const h=setup({retain:false});const {session_id:id}=h.create();let early;
 for(let i=0;i<1_000_000;i++) {
   h.setNow(i*60_000);h.registry.appendMutation(id,mutation,{snapshot:false});
   if(i%1024===1023) await h.registry.persist();
   if(i===999)early=JSON.stringify(h.registry.get(id)).length;
 }
 await h.registry.persist();
 assert.equal(sessionEventCount(h.registry.get(id)),1_000_000);assert.equal(h.stats().count,1_000_000);
 assert.ok(h.stats().maxBatch<=1024);assert.ok(JSON.stringify(h.registry.get(id)).length<early+100);
});

test('resumable journal upload retries durable cursor without rebuilding or resending accepted prefix',async()=>{
 const h=setup();const {session_id:id}=h.create();for(let i=0;i<9000;i++){h.registry.appendMutation(id,mutation,{snapshot:false});if(i%2048===2047)await h.registry.persist();}
 const draft=h.registry.sign(id);await h.registry.persist();let next=0, fail=true;const starts=[];
 const response={record_hash:draft.manifest.record_hash,url:'https://example.test/record',short_signature:'record',created:true};
 const fetch=async(url,init)=>{
   const body=JSON.parse(init.body);
   if(url.endsWith('/chunks')){starts.push(body.start_seq);assert.equal(body.start_seq,next);assert.ok(body.events.length<=4096);next+=body.events.length;if(fail){fail=false;throw new Error('response lost');}}
   return {ok:true,status:200,json:async()=>url.endsWith('/finalize')?response:{upload_id:draft.upload_id,next_seq:next,max_chunk_events:4096}};
 };
 const options={endpoint:'/api/record-uploads',fetch,payload:{upload_id:draft.upload_id,manifest:draft.manifest},readEvents:(start,count)=>h.registry.readEvents(id,start,count)};
 await assert.rejects(uploadJournal(options),/response lost/);assert.deepEqual(await uploadJournal(options),response);assert.deepEqual(starts,[0,4096,8192]);
});

test('discard waits for an in-flight accepted prefix before rollback after deletion failure',async()=>{
 const h=setup();const {session_id:id}=h.create();await h.registry.persist();
 let release,entered;const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
 const commit=h.storage.journal.commit.bind(h.storage.journal);let first=true;
 h.storage.journal.commit=async batch=>{if(first&&batch.appends.length){first=false;entered();await blocked;}if(batch.deleted.length)throw new Error('delete failed');await commit(batch);};
 h.registry.appendMutation(id,mutation);const save=h.registry.persist();await started;
 const discard=h.registry.discardPersisted([id]);release();await save;await assert.rejects(discard,/delete failed/);
 assert.equal(h.registry.get(id).event_count,1);assert.equal(h.events.get(id).length,1);
 await h.registry.persist();h.registry.appendMutation(id,mutation);await h.registry.persist();assert.equal(h.events.get(id).length,2);
});

test('failed journal publication keeps capture context frozen with the same capability',async()=>{
 const h=setup();const {session_id:id}=h.create();h.registry.appendMutation(id,mutation);const signed=h.registry.sign(id);h.registry.markFailedUpload(id,'offline');
 assert.throws(()=>h.registry.redactCaptureContext(id,{label:true}),/frozen|state/);assert.deepEqual(h.registry.sign(id),signed);
});

test('completed resumable acknowledgement must identify the same private upload',async()=>{
 const h=setup();const {session_id:id}=h.create();h.registry.appendMutation(id,mutation);const draft=h.registry.sign(id);
 await assert.rejects(uploadJournal({endpoint:'/api/record-uploads',payload:{upload_id:draft.upload_id,manifest:draft.manifest},readEvents:async()=>assert.fail('completed upload reads no events'),fetch:async()=>({ok:true,status:200,json:async()=>({upload_id:'wrong',next_seq:1,completed:{record_hash:draft.manifest.record_hash,url:'https://example.test/r',short_signature:'r',created:false}})})}),/identity/);
});
