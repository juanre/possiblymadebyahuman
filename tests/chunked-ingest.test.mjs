import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import { createIngestApi, computeRecordStats, generateShortSignature } from '../apps/ingest-api/src/index.ts';
import { computeRecordHash, computeEventHashChain, EventStreamVerifier } from '../packages/format/src/index.ts';
import { runDefaultAnalyzers } from '../packages/analyzers/src/index.ts';
import { InMemoryRecordStore, PostgresRecordStore } from '../packages/storage/src/index.ts';
import { applyMigrations, loadSqlMigrations } from '../packages/storage/src/migrations.ts';

const fixture = JSON.parse(await readFile('packages/conformance/vectors/golden-records.json','utf8'))[0].record;
function record(count=20) {
  const manifest={...structuredClone(fixture.manifest),session_id:randomUUID(),format_version:'0.3',event_count:count,duration_ms:2*365*86400000};
  const events=Array.from({length:count},(_,seq)=>({seq,t:seq*31+(seq>10?365*86400000:0),op:'insert',pos:seq,ins_len:1,del_len:0,source:'typing'}));
  manifest.record_hash=computeRecordHash(events,manifest.session_id,manifest.format_version,undefined,manifest);
  return {manifest,events};
}
function client(store,options={}) {
  const api=createIngestApi({store,...options});
  const call=async(path,body)=>{const response=await api.handleRequest(new Request(`http://local/api/${path}`,body===undefined?{}:{method:'POST',body:JSON.stringify(body)}));return {status:response.status,body:await response.json()};};
  return {api,call};
}
async function exercise(t,store,pool) {
  const {api,call}=client(store), r=record(9000), id=randomUUID();
  const shadowId=randomUUID();
  await call('record-uploads',{upload_id:shadowId,manifest:r.manifest});
  let begun=await call('record-uploads',{upload_id:id,manifest:r.manifest});
  assert.equal(begun.status,200,JSON.stringify(begun.body));assert.equal(begun.body.next_seq,0);assert.equal(begun.body.max_chunk_events,4096);
  assert.equal((await call(`record-uploads/${id}/finalize`,{})).body.error,'upload_incomplete');
  // Stage an earlier, invalid claimant to the same content address. It must
  // never become the source of public pages after a later valid publication.
  const shadow=structuredClone(r.events);shadow[0].ins_len=2;
  for(let start_seq=0;start_seq<shadow.length;start_seq+=4096)await call(`record-uploads/${shadowId}/chunks`,{start_seq,events:shadow.slice(start_seq,start_seq+4096)});
  const chunk=r.events.slice(0,4096);
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:1,events:chunk})).status,409);
  const invalid=structuredClone(chunk);invalid[300].t=0;
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:invalid})).status,400);
  assert.equal((await call(`record-uploads/${id}`)).body.next_seq,0,'invalid chunk is atomic');
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:chunk})).body.next_seq,4096);
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:chunk})).body.next_seq,4096,'lost ACK retries identical chunk');
  const changed=structuredClone(chunk);changed[0].ins_len=2;
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:changed})).body.error,'upload_chunk_conflict');
  assert.equal((await call('record-uploads',{upload_id:id,manifest:{...r.manifest,duration_ms:r.manifest.duration_ms+1}})).status,409);
  const resumed=client(pool ? new PostgresRecordStore(pool):store).call;
  assert.equal((await resumed('record-uploads',{upload_id:id,manifest:r.manifest})).body.next_seq,4096);
  for(let start_seq=4096;start_seq<r.events.length;start_seq+=4096) assert.equal((await resumed(`record-uploads/${id}/chunks`,{start_seq,events:r.events.slice(start_seq,start_seq+4096)})).status,200);
  const saved=await resumed(`record-uploads/${id}/finalize`,{});assert.equal(saved.status,201,JSON.stringify(saved.body));
  assert.equal((await resumed(`record-uploads/${id}/finalize`,{})).body.created,false);
  assert.equal((await resumed(`record-uploads/${shadowId}/finalize`,{})).body.created,false);
  assert.equal((await resumed('record-uploads',{upload_id:id,manifest:r.manifest})).body.completed.record_hash,r.manifest.record_hash);
  assert.equal((await api.getRecord(saved.body.short_signature)).body.error,'chunked_record_requires_pagination');
  const summary=await resumed(`records/${saved.body.short_signature}/summary`);
  assert.equal(summary.status,200);assert.equal('events' in summary.body,false);assert.equal(summary.body.first_event_t,0);assert.equal(summary.body.last_event_t,r.events.at(-1).t);
  assert.deepEqual(summary.body.stats,computeRecordStats(r));const normalizeSignals=signals=>signals.map(({human_range,...signal})=>signal).sort((a,b)=>a.analyzer_id.localeCompare(b.analyzer_id));assert.deepEqual(normalizeSignals(summary.body.signals),normalizeSignals(runDefaultAnalyzers(r)));
  const verifier=new EventStreamVerifier(summary.body.manifest);let offset=0,prior=null;
  while(offset!==null){const page=(await resumed(`records/${saved.body.short_signature}/events?offset=${offset}&limit=777`)).body;assert.equal(page.chain_tip_before,prior);assert.ok(page.events.length<=777);for(const event of page.events)verifier.append(event);assert.equal(verifier.chainTip,page.chain_tip_after);prior=page.chain_tip_after;offset=page.next_offset;}
  assert.equal(verifier.finish().valid,true);
  const empty=(await resumed(`records/${saved.body.short_signature}/events?offset=9000&limit=1`)).body;assert.deepEqual(empty.events,[]);assert.equal(empty.chain_tip_before,prior);assert.equal(empty.next_offset,null);
  assert.equal((await resumed(`records/${saved.body.short_signature}/events?offset=-1`)).status,400);
  if(pool){const stored=(await pool.query('select events,event_storage from records where record_hash=$1',[r.manifest.record_hash])).rows[0];assert.deepEqual(stored.events,[]);assert.equal(stored.event_storage,'chunks');const rows=(await pool.query('select max(jsonb_array_length(events)) as maximum,count(*)::integer as count from record_event_chunks where upload_id=$1',[id])).rows[0];assert.equal(rows.maximum,4096);assert.equal(rows.count,3);
    const transient=(await pool.query('select (select count(*) from upload_delay_counts where upload_id=$1)::integer as delays,(select count(*) from record_event_chunks where upload_id=$2)::integer as shadow',[id,shadowId])).rows[0];assert.deepEqual(transient,{delays:0,shadow:0});}
}
test('chunked publication resumes atomically, verifies bounded pages, and keeps exact legacy statistics',async t=>exercise(t,new InMemoryRecordStore()));
test('chunked PostgreSQL publication persists bounded chunks and resumes across server instances',async t=>{
  if(!process.env.PMBAH_TEST_DATABASE_URL){t.skip('requires managed PostgreSQL test database');return;}
  const pool=new pg.Pool({connectionString:process.env.PMBAH_TEST_DATABASE_URL});t.after(()=>pool.end());
  await applyMigrations(pool,await loadSqlMigrations());await exercise(t,new PostgresRecordStore(pool),pool);
});
test('chunk validation rejects plaintext, bad sealing, and supports explicit observation fallback',async()=>{
  const {call,api}=client(new InMemoryRecordStore()),r=record(3),id=randomUUID();
  const tips=computeEventHashChain(r.events,r.manifest.session_id,r.manifest.format_version);
  const checkpoint=await api.postObservedCheckpoint(r.manifest.session_id,{event_count:2,chain_tip:tips[1]});
  const observation={observed_session_id:r.manifest.session_id,token:checkpoint.body.token};
  assert.equal((await call('record-uploads',{upload_id:id,manifest:r.manifest,observation})).status,200);
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:[{...r.events[0],text:'private'}]})).body.error,'content_not_allowed');
  assert.equal((await call(`record-uploads/${id}/chunks`,{start_seq:0,events:r.events})).status,200);
  const saved=await call(`record-uploads/${id}/finalize`,{});assert.equal(saved.status,201);
  const summary=(await call(`records/${saved.body.short_signature}/summary`)).body;assert.equal(summary.observation.state,'partial');assert.equal(JSON.stringify(summary).includes(checkpoint.body.token),false);
  assert.deepEqual((await api.getRecord(saved.body.short_signature)).body.events,r.events);
  const bad=record(2),bid=randomUUID();bad.manifest.record_hash='b3:'+'1'.repeat(64);
  await call('record-uploads',{upload_id:bid,manifest:bad.manifest});await call(`record-uploads/${bid}/chunks`,{start_seq:0,events:bad.events});assert.equal((await call(`record-uploads/${bid}/finalize`,{})).body.error,'verification_failed');
  const fallback=record(2),fid=randomUUID();await call('record-uploads',{upload_id:fid,manifest:fallback.manifest,observation:{observed_session_id:randomUUID(),token:'a'.repeat(64)}});await call(`record-uploads/${fid}/chunks`,{start_seq:0,events:fallback.events});assert.equal((await call(`record-uploads/${fid}/finalize`,{})).body.error,'observation_unavailable');await call('record-uploads',{upload_id:fid,manifest:fallback.manifest,observation:{state:'unobserved'}});const accepted=await call(`record-uploads/${fid}/finalize`,{});assert.equal(accepted.status,201);assert.equal((await call(`records/${accepted.body.short_signature}/summary`)).body.observation.state,'unobserved');
});

test('chunked PostgreSQL observation validates every commitment and publishes only once',async t=>{
  if(!process.env.PMBAH_TEST_DATABASE_URL){t.skip('requires managed PostgreSQL test database');return;}
  const pool=new pg.Pool({connectionString:process.env.PMBAH_TEST_DATABASE_URL});t.after(()=>pool.end());await applyMigrations(pool,await loadSqlMigrations());
  const {call,api}=client(new PostgresRecordStore(pool)),r=record(40),id=randomUUID(),tips=computeEventHashChain(r.events,r.manifest.session_id,'0.3');
  let token;
  for(let i=1;i<=40;i++){const response=await api.postObservedCheckpoint(r.manifest.session_id,{event_count:i,chain_tip:tips[i-1],...(token?{token}:{})});assert.equal(response.status,201);token=response.body.token;}
  await call('record-uploads',{upload_id:id,manifest:r.manifest,observation:{observed_session_id:r.manifest.session_id,token}});
  await call(`record-uploads/${id}/chunks`,{start_seq:0,events:r.events});
  // A hidden middle anchor must still be validated, even though public summaries
  // return the first and final 31 commitments only.
  await pool.query('update observed_checkpoints set chain_tip=$2 where observed_session_id=$1 and event_count=5',[r.manifest.session_id,'b3:'+'0'.repeat(64)]);
  assert.equal((await call(`record-uploads/${id}/finalize`,{})).body.error,'observation_mismatch');
  assert.equal((await pool.query('select count(*)::integer as count from records where record_hash=$1',[r.manifest.record_hash])).rows[0].count,0);
  await pool.query('update observed_checkpoints set chain_tip=$2 where observed_session_id=$1 and event_count=5',[r.manifest.session_id,tips[4]]);
  const responses=await Promise.all([call(`record-uploads/${id}/finalize`,{}),call(`record-uploads/${id}/finalize`,{})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,201]);
  const summary=(await call(`records/${responses[0].body.short_signature}/summary`)).body;
  assert.equal(summary.observation.checkpoint_count,40);assert.equal(summary.observation.commitments.length,32);assert.equal(summary.observation.state,'observed');
  assert.equal((await api.postObservedCheckpoint(r.manifest.session_id,{event_count:41,chain_tip:tips[39],token})).status,409);
});

test('four million events publish and verify through bounded PostgreSQL pages', {skip:process.env.PMBAH_SCALE_EVENTS!=='4000000'}, async t=>{
  const {advanceEventHash,sealRecordHash}=await import('../packages/format/src/index.ts');
  assert.ok(process.env.PMBAH_TEST_DATABASE_URL);
  const pool=new pg.Pool({connectionString:process.env.PMBAH_TEST_DATABASE_URL});t.after(()=>pool.end());await applyMigrations(pool,await loadSqlMigrations());
  const {call}=client(new PostgresRecordStore(pool)),count=4_000_000,id=randomUUID(),session=randomUUID(),duration=2*365*86400000;
  const event=seq=>({seq,t:Math.floor(seq*duration/count),op:'insert',pos:seq,ins_len:1,del_len:0,source:'typing'});
  let tip=null;for(let seq=0;seq<count;seq++)tip=advanceEventHash(tip,event(seq),session,'0.3');
  const manifest={...fixture.manifest,format_version:'0.3',session_id:session,event_count:count,duration_ms:duration};manifest.record_hash=sealRecordHash(tip,'0.3',undefined,manifest);
  const start=performance.now();await call('record-uploads',{upload_id:id,manifest});let maxHeap=0;
  for(let start_seq=0;start_seq<count;start_seq+=4096){const events=Array.from({length:Math.min(4096,count-start_seq)},(_,i)=>event(start_seq+i));const response=await call(`record-uploads/${id}/chunks`,{start_seq,events});assert.equal(response.status,200,JSON.stringify(response.body));maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed);}
  const result=await call(`record-uploads/${id}/finalize`,{});assert.equal(result.status,201,JSON.stringify(result.body));const publishedMs=performance.now()-start;
  const summary=(await call(`records/${result.body.short_signature}/summary`)).body;assert.equal(summary.stats.event_count,count);assert.equal(summary.stats.inserted_codepoints_total,count);
  const verifier=new EventStreamVerifier(summary.manifest);let offset=0;while(offset!==null){const page=(await call(`records/${result.body.short_signature}/events?offset=${offset}&limit=4096`)).body;assert.ok(page.events.length<=4096);for(const e of page.events)verifier.append(e);offset=page.next_offset;maxHeap=Math.max(maxHeap,process.memoryUsage().heapUsed);}
  assert.equal(verifier.finish().valid,true);
  const raw=(await pool.query('select jsonb_array_length(events) as inline_count from records where record_hash=$1',[manifest.record_hash])).rows[0];assert.equal(raw.inline_count,0);
  t.diagnostic(JSON.stringify({events:count,published_ms:Math.round(publishedMs),total_ms:Math.round(performance.now()-start),max_heap_mb:Math.round(maxHeap/1048576)}));
});


test('chunked configured array analyzers report unavailable, empty registry stays empty, and signature allocation retries races',async()=>{
  for(const analyzers of [[],[{id:'custom-array',version:'1.2.3',analyze(){throw new Error('must not materialize events');}}]]){
    const store=new InMemoryRecordStore();const original=store.chunked.finalize.bind(store.chunked);let attempts=0;
    store.chunked.finalize=async(...args)=>{if(attempts++===0)throw Object.assign(new Error('concurrent signature owner'),{code:'23505'});return original(...args);};
    const {call}=client(store,{analyzers,initialShortSignatureLength:1}),r=record(3),id=randomUUID();
    await call('record-uploads',{upload_id:id,manifest:r.manifest});await call(`record-uploads/${id}/chunks`,{start_seq:0,events:r.events});
    const saved=await call(`record-uploads/${id}/finalize`,{});assert.equal(saved.status,201);assert.equal(saved.body.short_signature.length,1);assert.equal(attempts,2);
    const summary=(await call(`records/${saved.body.short_signature}/summary`)).body;assert.equal(summary.signals.length,analyzers.length);
    if(analyzers.length){assert.equal(summary.signals[0].analyzer_id,'custom-array');assert.equal(summary.signals[0].applicable,false);assert.match(summary.signals[0].explanation,/complete event array/);}
  }
});


test('PostgreSQL concurrent short-signature prefix collisions retry without partial publication',async t=>{
  if(!process.env.PMBAH_TEST_DATABASE_URL){t.skip('requires managed PostgreSQL test database');return;}
  const pool=new pg.Pool({connectionString:process.env.PMBAH_TEST_DATABASE_URL});t.after(()=>pool.end());await applyMigrations(pool,await loadSqlMigrations());
  const store=new PostgresRecordStore(pool), {call}=client(store,{initialShortSignatureLength:1});
  const candidates=new Map();let pair;
  for(let i=0;i<100;i++){const r=record(1),prefix=await generateShortSignature(r.manifest.record_hash,store,1);if(candidates.has(prefix)){pair=[candidates.get(prefix),r];break;}candidates.set(prefix,r);}
  assert.ok(pair);const ids=pair.map(()=>randomUUID());
  for(let i=0;i<2;i++){await call('record-uploads',{upload_id:ids[i],manifest:pair[i].manifest});await call(`record-uploads/${ids[i]}/chunks`,{start_seq:0,events:pair[i].events});}
  const replies=await Promise.all(ids.map(id=>call(`record-uploads/${id}/finalize`,{})));assert.deepEqual(replies.map(r=>r.status),[201,201]);assert.notEqual(replies[0].body.short_signature,replies[1].body.short_signature);
  for(let i=0;i<2;i++)assert.equal((await call(`records/${replies[i].body.short_signature}/summary`)).body.manifest.record_hash,pair[i].manifest.record_hash);
});


test('legacy observed uploads bound checkpoint reads and reject oversized prefixes before publication',async t=>{
  if(!process.env.PMBAH_TEST_DATABASE_URL){t.skip('requires managed PostgreSQL test database');return;}
  const pool=new pg.Pool({connectionString:process.env.PMBAH_TEST_DATABASE_URL});t.after(()=>pool.end());await applyMigrations(pool,await loadSqlMigrations());
  const actual=new PostgresRecordStore(pool),r=record(1),created=await createIngestApi({store:actual}).postObservedCheckpoint(r.manifest.session_id,{event_count:1,chain_tip:computeEventHashChain(r.events,r.manifest.session_id,'0.3')[0]});
  await pool.query(`insert into observed_checkpoints(checkpoint_id,observed_session_id,event_count,chain_tip,observed_at)
    select gen_random_uuid(),$1,n,$2,now() from generate_series(2,10000) n`,[r.manifest.session_id,'b3:'+'0'.repeat(64)]);
  const reads=[];const instrumented={query:async(sql,params)=>{const result=await pool.query(sql,params);if(/from observed_checkpoints/.test(sql)){reads.push(result.rows.length);assert.ok(result.rows.length<=2,'legacy body has one event, so only a bounded commitment prefix may load');}return result;},connect:()=>pool.connect()};
  const api=createIngestApi({store:new PostgresRecordStore(instrumented)});
  const response=await api.postRecord({...r,observation:{observed_session_id:r.manifest.session_id,token:created.body.token}});
  assert.equal(response.status,409);assert.equal(response.body.error,'observation_mismatch');assert.deepEqual(reads,[2]);
  reads.length=0;
  assert.equal((await api.postRecord({...r,observation:{observed_session_id:r.manifest.session_id,token:'wrong'.repeat(16)}})).body.error,'observation_unavailable');assert.deepEqual(reads,[],'authenticate before fetching checkpoint data');
});
