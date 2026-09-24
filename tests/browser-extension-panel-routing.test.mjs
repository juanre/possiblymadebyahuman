import "fake-indexeddb/auto";
import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the actual worker boundary, including window/frame/document identity.
test('panel summaries follow exact editors, protect local names, and reject changed finish scope before stopping', async () => {
  globalThis.__PMBAH_EXT_VERSION__ = '0.3.0-test';
  globalThis.__PMBAH_EXT_BASE_URL__ = 'https://example.test';
  globalThis.__PMBAH_EXT_RECORDS_ENDPOINT__ = 'https://example.test/api/records';
  const previousChrome = globalThis.chrome, previousFetch = globalThis.fetch;
  const storage = {}, handlers = {};
  let currentSession, active = true, failStorage = false, scope = 'selection', token = 'selected-1';
  let documentId = 'document-a', navigateAfterProbe = false;
  const own = {id:'panel-test',url:'chrome-extension://panel-test/popup.html'};
  const content = {id:'panel-test',url:'https://example.test/editor',tab:{id:12},frameId:3,documentId:'document-a'};
  const descriptor = {tag_name:'TEXTAREA',field_kind:'textarea',aria_label:'Editor',id:null,name:null,nearest_form_id:null,dom_signature:'shape',index_among_similar:0};
  const invoke = (message,sender=own) => new Promise(resolve=>handlers.message(message,sender,resolve));
  const queries=[];
  globalThis.fetch = async ()=>new Response('{}',{status:503});
  globalThis.chrome = {
    runtime:{id:'panel-test',onMessage:{addListener:fn=>handlers.message=fn},onInstalled:{addListener:()=>{}}},
    storage:{local:{get:async keys=>Object.fromEntries(keys.filter(k=>k in storage).map(k=>[k,structuredClone(storage[k])])),set:async values=>{if(failStorage)throw new Error('storage full');Object.assign(storage,structuredClone(values));},remove:async()=>{}}},
    tabs:{query:async query=>{queries.push(query);return [{id:query.windowId===2?99:12}];},onRemoved:{addListener:()=>{}},sendMessage:async(tab,message,options)=>{
      if(message.kind==='probe_editor'){ if(navigateAfterProbe) documentId='replacement-document'; return {focused:options.frameId===3,session_id:currentSession}; }
      if(message.kind==='capture_status')return {active};
      if(message.kind==='inspect_finish')return {scope,scope_token:token};
      if(message.kind==='freeze_session'){
        if(message.bind && message.expected_scope_token!==token)return {kind:'binding_scope_changed',scope,scope_token:token};
        active=false;return {kind:'binding_result',text_binding:null};
      }
      if(message.kind==='start_editor'){
        const result=await invoke({kind:'register_field',tab_id:-1,frame_id:-1,origin_url:'https://example.test',page_path:'/editor',page_title:'Editor',descriptor,field_is_empty:true,activation_id:message.activation_id},content);
        currentSession=result.result.session_id;
        return {kind:'start_editor_result',session_id:currentSession};
      }
      throw new Error(`unexpected ${message.kind}`);
    }},
    webNavigation:{getAllFrames:async({tabId})=>[{frameId:3,documentId:tabId===99?'other-document':documentId}],onCommitted:{addListener:()=>{}}},
    contextMenus:{create:()=>{},removeAll:async()=>{},onClicked:{addListener:()=>{}}},
    sidePanel:{setPanelBehavior:async()=>{},open:async()=>{}},action:{setBadgeText:async()=>{},setBadgeBackgroundColor:async()=>{}},commands:{onCommand:{addListener:()=>{}}},alarms:{create:()=>{},onAlarm:{addListener:()=>{}}},
  };
  try {
    await import(`../apps/browser-extension/src/background/service-worker.ts?panel=${Date.now()}`);
    await invoke({kind:'start_focused_editor',window_id:1});
    const id=currentSession;
    await invoke({kind:'append_mutation',session_id:id,mutation:{op:'insert',pos:0,del_len:0,ins_len:2,source:'typing'}},content);
    const listed=await invoke({kind:'list_panel_sessions',window_id:1});
    assert.deepEqual(listed.current_editor,{state:'tracked',session_id:id});
    assert.equal(listed.drafts[0].event_count,1);
    assert.equal(listed.drafts[0].events,undefined);
    assert.equal(listed.drafts[0].observation,undefined);
    assert.equal(queries.at(-1).windowId,1);
    const otherWindow=await invoke({kind:'list_panel_sessions',window_id:2});
    assert.deepEqual(otherWindow.current_editor,{state:'untracked'},'same claimed session in another document cannot select this draft');
    currentSession=undefined;
    assert.deepEqual((await invoke({kind:'list_panel_sessions',window_id:1})).current_editor,{state:'untracked'});
    currentSession=id;
    for(const kind of ['list_panel_sessions','rename_session','export_saved','clear_saved','remove_saved','inspect_finish']) assert.equal((await invoke({kind,window_id:1,session_id:id,name:'injected'},content)).kind,'error');
    assert.equal((await invoke({kind:'rename_session',session_id:id,name:'Private project'})).kind,'rename_result');
    let updated=await invoke({kind:'list_panel_sessions',window_id:1});
    assert.equal(updated.drafts[0].display_name,'Private project');
    assert.equal(updated.drafts[0].capture_context.label,'Editor','private name never changes published label');
    failStorage=true;
    assert.equal((await invoke({kind:'rename_session',session_id:id,name:'Lost rename'})).kind,'error');
    failStorage=false;
    updated=await invoke({kind:'list_panel_sessions',window_id:1});
    assert.equal(updated.drafts[0].display_name,'Private project','failed rename restores the visible durable name');
    // A failed rename in one panel must not undo a later successful rename.
    const originalSet=chrome.storage.local.set;
    let releaseWrite, enteredWrite;
    const firstWriteEntered=new Promise(resolve=>enteredWrite=resolve);
    let writes=0;
    chrome.storage.local.set=async values=>{
      if(++writes===1){ enteredWrite(); await new Promise(resolve=>releaseWrite=resolve); throw new Error('first rename failed'); }
      return originalSet(values);
    };
    const firstRename=invoke({kind:'rename_session',session_id:id,name:'First rename'});
    await firstWriteEntered;
    const laterRename=invoke({kind:'rename_session',session_id:id,name:'Second rename'});
    await new Promise(resolve=>setTimeout(resolve,0));
    releaseWrite();
    assert.equal((await firstRename).kind,'error');
    assert.equal((await laterRename).kind,'rename_result');
    chrome.storage.local.set=originalSet;
    assert.equal((await invoke({kind:'list_panel_sessions',window_id:1})).drafts[0].display_name,'Second rename');
    const preview=await invoke({kind:'inspect_finish',session_id:id});
    assert.equal(preview.scope,'selection');
    token='whole-2';scope='whole_field';
    const changed=await invoke({kind:'prepare_finish',session_id:id,bind:true,expected_scope_token:preview.scope_token});
    assert.equal(changed.scope_changed,true);
    assert.equal(changed.scope,'whole_field');
    assert.equal(active,true,'changed scope must not stop capture');
    assert.equal(storage['pmbah:explicit-capture:v1'].snapshots[id],undefined);
    assert.equal((await invoke({kind:'append_mutation',session_id:id,mutation:{op:'insert',pos:2,del_len:0,ins_len:1,source:'typing'}},content)).kind,'append_mutation_result');
    await invoke({kind:'prepare_finish',session_id:id,bind:false});
    assert.equal(active,false);
    navigateAfterProbe=true;
    const stale=await invoke({kind:'start_focused_editor',window_id:1});
    assert.equal(stale.session_id,undefined);
    assert.match(stale.reason,/page changed/,'a focus probe cannot authorize a replacement document');
  } finally {globalThis.chrome=previousChrome;globalThis.fetch=previousFetch;}
});
