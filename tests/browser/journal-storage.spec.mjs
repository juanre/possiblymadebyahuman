import { test, expect } from '@playwright/test';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
let bundle;
test.beforeAll(async()=>{
 const output=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('../../packages/browser-storage/src/index.ts',import.meta.url)),formats:['es']}}});
 bundle=(Array.isArray(output)?output[0]:output).output.find(chunk=>chunk.type==='chunk').code;
});
async function prepare(page){
 await page.route('**/journal-test.js',route=>route.fulfill({contentType:'text/javascript',body:bundle}));
 await page.goto('/extension-page');
 await page.evaluate(async()=>{window.Journal=(await import('/journal-test.js')).IndexedDbSessionStorage;window.legacyMetadata={base_wall_ms:0,last_edit_wall_ms:10000,state:'active',origin:{},descriptor:{},producer:{},capture_context:{}};});
}
test('journal migrates, verifies and retires legacy snapshot, then appends atomic metadata only',async({page})=>{
 await prepare(page);
 const outcome=await page.evaluate(async()=>{
  const event={seq:0,t:1,op:'insert',pos:0,ins_len:1,del_len:0,source:'typing'};
  const old=[{...window.legacyMetadata,session_id:'00000000-0000-4000-8000-000000000001',format_version:'0.3',events:[event],last_event_chain_tip:null}];
  let removed=false;const storage=new window.Journal({name:'migration-success',legacyRead:async()=>old,legacyRemove:async()=>{removed=true;}});
  const sessions=await storage.read();const events=await storage.readEvents(old[0].session_id,0,512);
  const later={...event,seq:1,t:2};
  await storage.commit({sessions:[{...sessions[0],event_count:2,last_event_t:2}],appends:[{session_id:old[0].session_id,events:[later]}],deleted:[],clear_events:[]});
  const after=await storage.read();
  let rejected=false;try{await storage.commit({sessions:[{...sessions[0],event_count:99}],appends:[{session_id:old[0].session_id,events:[later]}],deleted:[],clear_events:[]});}catch{rejected=true;}
  return {removed,sessions,events,after,rejected,final:await storage.read()};
 });
 expect(outcome.removed).toBe(true);expect(outcome.sessions[0]).toMatchObject({events:[],journaled:true,event_count:1,last_event_t:1});
 expect(outcome.events).toHaveLength(1);expect(outcome.after[0].event_count).toBe(2);expect(outcome.rejected).toBe(true);expect(outcome.final[0].event_count).toBe(2);
});
test('interrupted migration preserves legacy and safely replaces partial imported prefix on retry',async({page})=>{
 await prepare(page);
 const outcome=await page.evaluate(async()=>{
  const events=Array.from({length:1100},(_,seq)=>({seq,t:seq,op:'insert',pos:seq,ins_len:1,del_len:0,source:'typing'}));
  const old=[{...window.legacyMetadata,session_id:'00000000-0000-4000-8000-000000000001',format_version:'0.3',events,last_event_chain_tip:null}];
  let removed=false;const options={name:'migration-interrupted',legacyRead:async()=>old,legacyRemove:async()=>{removed=true;}};
  const storage=new window.Journal(options);const commit=storage.commit.bind(storage);let written=0;
  storage.commit=async batch=>{if(batch.appends.length&&++written===2)throw new Error('quota');return commit(batch);};
  let failure;try{await storage.read();}catch(error){failure=error.message;}
  const preserved=!removed;
  const retried=new window.Journal(options);const sessions=await retried.read();const read=await retried.readEvents(old[0].session_id,0,4096);
  return {failure,preserved,removed,count:sessions[0].event_count,read:read.length,sequences:read.every((e,i)=>e.seq===i)};
 });
 expect(outcome).toEqual({failure:'quota',preserved:true,removed:true,count:1100,read:1100,sequences:true});
});
test('corrupt legacy hash fails closed and preserves original',async({page})=>{
 await prepare(page);
 const outcome=await page.evaluate(async()=>{
  let removed=false;const storage=new window.Journal({name:'migration-invalid',legacyRead:async()=>[{...window.legacyMetadata,session_id:'00000000-0000-4000-8000-000000000001',format_version:'0.3',events:[{seq:0,t:1,op:'insert',pos:0,ins_len:1,del_len:0,source:'typing'}],last_event_chain_tip:'b3:bad'}],legacyRemove:async()=>{removed=true;}});
  try{await storage.read();return {removed};}catch(error){return {removed,error:error.message};}
 });
 expect(outcome.removed).toBe(false);expect(outcome.error).toContain('differs');
});
for(const invalid of ['duplicate','empty-id','empty-version','summary'])test(`migration rejects ${invalid} metadata and retains the source`,async({page})=>{
 await prepare(page);
 const outcome=await page.evaluate(async invalid=>{
  let removed=false;const session={...window.legacyMetadata,session_id:'00000000-0000-4000-8000-000000000001',format_version:'0.3',events:[],last_event_chain_tip:null};
  if(invalid==='empty-id')session.session_id='not-a-uuid';if(invalid==='empty-version')session.format_version='9.0';if(invalid==='summary')session.event_count=1;
  const storage=new window.Journal({name:`invalid-${invalid}`,legacyRead:async()=>invalid==='duplicate'?[session,{...session}]:[session],legacyRemove:async()=>{removed=true;}});
  try{await storage.read();return{removed};}catch(error){return{removed,error:error.message};}
 },invalid);
 expect(outcome.removed).toBe(false);expect(outcome.error).toContain(invalid==='duplicate'?'Duplicate':'Invalid');
});
