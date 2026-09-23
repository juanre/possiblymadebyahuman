import test from 'node:test';
import assert from 'node:assert/strict';
import { ensurePanelNames, savedLink, savedPage, sessionSummary } from '../apps/browser-extension/src/lib/panel-model.ts';

const session = (index) => ({
  session_id: `session-${index}`, state: 'uploaded',
  origin: {origin:'https://example.test',path:'/draft',tab_id:1,frame_id:0},
  descriptor: {aria_label:'Editor',tag_name:'TEXTAREA'},
  last_edit_wall_ms: 1700000000000 + index * 86400000,
  events:[{seq:0}], observation:{last_observed_token:'private-secret'},
  uploaded_response:{url:`https://records.test/saved${index}`,record_hash:`b3:${index}`},
});

test('two hundred saved records have stable private names and bounded searchable pages without eviction', () => {
  const all = Array.from({length:200}, (_,index)=>session(index));
  const state = {};
  assert.equal(ensurePanelNames(state,all),true);
  const originals = {...state.names};
  assert.equal(new Set(Object.values(originals)).size,200);
  assert.equal(ensurePanelNames(state,all.slice().reverse()),false);
  assert.deepEqual(state.names,originals);
  const first = savedPage(all,state.names);
  assert.equal(first.total,200);
  assert.equal(first.sessions.length,20);
  assert.equal(first.sessions[0].session_id,'session-199');
  const second = savedPage(all,state.names,'',20,20);
  assert.equal(second.sessions[0].session_id,'session-179');
  assert.equal(savedPage(all,state.names,'saved198').matching,1);
  state.names['session-2'] = 'A private project name';
  assert.equal(savedPage(all,state.names,'private project').sessions[0].session_id,'session-2');
  assert.equal(savedPage(all,state.names,'missing').sessions.length,0);
  assert.equal(savedPage(all,state.names,'',0,100000).sessions.length,50);
  assert.equal(all.length,200);
  assert.equal(savedPage(all.slice(0,20),state.names,'',20,20).offset,0,'deleting the last page returns to a complete preceding page');
});

test('panel summaries and exports contain no events or checkpoint credentials', () => {
  const original = session(1);
  const summary = sessionSummary(original,'A private name','stopped');
  assert.equal(summary.event_count,1);
  assert.equal(summary.events,undefined);
  assert.equal(summary.observation,undefined);
  assert.ok(!JSON.stringify(summary).includes('private-secret'));
  const exported = savedLink(original,'A private name');
  assert.deepEqual(Object.keys(exported).sort(),['name','record_hash','saved_at','session_id','site','text_check','url']);
  assert.equal(exported.url,original.uploaded_response.url);
  assert.ok(!JSON.stringify(exported).includes('private-secret'));
  assert.equal(original.capture_context,undefined,'private naming never mutates public context');
});

 test('generated names stay editable within the private-name limit', () => {
  const record=session(1);record.origin.origin='https://'+'a'.repeat(63)+'.'+'b'.repeat(63)+'.test';record.descriptor.aria_label='label'.repeat(100);
  const state={};ensurePanelNames(state,[record]);
  assert.ok(state.names[record.session_id].length <=160);
  assert.match(state.names[record.session_id],/ · 1$/);
 });
