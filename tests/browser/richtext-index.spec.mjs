import {test,expect} from '@playwright/test';
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
let bundle;
test.beforeAll(async()=>{const out=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('../../apps/browser-extension/src/lib/richtext-index.ts',import.meta.url)),formats:['es']}}});bundle=(Array.isArray(out)?out[0]:out).output[0].code;});
async function prepare(page){await page.route('**/rich-index.js',r=>r.fulfill({contentType:'text/javascript',body:bundle}));await page.goto('/extension-page');await page.evaluate(async()=>{window.RichIndex=(await import('/rich-index.js')).RichTextIndex;});}
test('incremental DOM weights match reference projection after arbitrary structural edits',async({page})=>{
 await prepare(page);
 const failures=await page.evaluate(()=>{
  const root=document.createElement('div');root.contentEditable='true';document.body.append(root);
  // Independent direct projection is an oracle, never a production fallback.
  function reference(){
   const bases=new Map(),bounds=new Map();let length=0;const block=n=>n instanceof HTMLElement&&/^(DIV|P|LI|UL|OL|BLOCKQUOTE|PRE|H[1-6])$/.test(n.tagName);
   function placeholder(node){let cursor=node;while(cursor&&cursor!==root){let sibling=cursor.nextSibling;while(sibling){if(sibling.nodeType!==8&&!(sibling.nodeType===3&&sibling.length===0))return false;sibling=sibling.nextSibling;}cursor=cursor.parentNode;if(cursor instanceof HTMLElement&&(cursor===root||block(cursor)))return true;}return true;}
   function visit(node){bases.set(node,length);if(node.nodeType===3){length+=[...node.data].length;return;}if(node.nodeType===8)return;const offsets=[];let previous;for(const child of node.childNodes){offsets.push(length);if(child.nodeType===8)continue;if(previous&&(block(child)||block(previous)))length++;if(child.nodeName==='BR'){bases.set(child,length);if(!placeholder(child))length++;}else visit(child);previous=child;}offsets.push(length);bounds.set(node,offsets);}
   visit(root);return{length,offset:(node,i)=>node.nodeType===3?bases.get(node)+[...node.data.slice(0,i)].length:bounds.get(node)?.[i]??bases.get(node)};
  }
  const index=new window.RichIndex(root),failures=[];
  function check(label){const ref=reference();const nodes=[root,...root.querySelectorAll('*')];const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);while(walker.nextNode())nodes.push(walker.currentNode);for(const node of nodes){const max=node.nodeType===3?node.length:node.childNodes.length;for(let i=0;i<=max;i++){const range=new Range();range.setStart(node,i);range.collapse(true);const got=index.measure(range);if(got.length!==ref.length||got.start!==ref.offset(node,i)){failures.push({label,html:root.innerHTML,node:node.nodeName,i,got,expected:{length:ref.length,start:ref.offset(node,i)}});return;}}}}
  for(const html of ['<br>','<span><br></span><span></span>','<p>a🙂</p><p><br></p>','<span>a<br></span><b>b</b>','a<!--x--><br><span><br></span>','<div>a<span><br></span></div><div>b</div>','<span><br></span><i><br></i><p>c</p>']){root.innerHTML=html;check('fixture');}
  root.replaceChildren(document.createElement('br'),document.createTextNode(''),document.createElement('span'));check('BR before empty text and visible inline');
  let seed=17;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
  for(let step=0;step<300;step++){
   for(let batch=0;batch<3;batch++){
   const parents=[root,...root.querySelectorAll('div,p,span,b')];const parent=parents[random(parents.length)];
   if(random(3)===0&&parent.childNodes.length)parent.childNodes[random(parent.childNodes.length)].remove();
   else {const choices=['span','p','br','b'];const node=random(2)?document.createTextNode(['x','🙂',''][random(3)]):document.createElement(choices[random(choices.length)]);parent.insertBefore(node,parent.childNodes[random(parent.childNodes.length+1)]??null);}
   }
   check(`random ${step}`);if(failures.length>8)break;
  }
  return failures;
 });
 expect(failures).toEqual([]);
});
test('large rich leaves and large sibling sets update without scanning unchanged content',async({page})=>{
 await prepare(page);
 const result=await page.evaluate(()=>{
  const root=document.createElement('div');root.contentEditable='true';document.body.append(root);
  for(let i=0;i<10000;i++){const p=document.createElement('p');p.textContent=i===9999?'a'.repeat(4_000_000):'ab';root.append(p);}
  const index=new window.RichIndex(root),leaf=root.lastChild.firstChild;let scans=0,rootReads=0;
  const native=String.prototype.charCodeAt;String.prototype.charCodeAt=function(...args){scans++;return native.apply(this,args);};
  const childNodes=Object.getOwnPropertyDescriptor(Node.prototype,'childNodes').get;Object.defineProperty(root,'childNodes',{get(){rootReads++;return childNodes.call(this);}});
  try{
   for(let i=0;i<100;i++){const range=new Range();range.setStart(leaf,leaf.length);range.collapse(true);index.prepare(range,'insertText',1);leaf.appendData('x');const selection=getSelection();selection.removeAllRanges();range.setStart(leaf,leaf.length);selection.addRange(range);index.measure();}
   const paragraph=document.createElement('p');paragraph.textContent='tail';root.append(paragraph);const measured=index.measure();return{scans,rootReads,length:measured.length};
  }finally{String.prototype.charCodeAt=native;}
 });
 expect(result.rootReads).toBe(0);expect(result.scans).toBeLessThan(1000);expect(result.length).toBe(4_030_102);
});
test('native formatting preserves indexed length through moved text nodes',async({page})=>{
 await prepare(page);
 const result=await page.evaluate(()=>{
  const root=document.createElement('div');root.contentEditable='true';root.textContent='hello';document.body.append(root);root.focus();
  const index=new window.RichIndex(root),range=new Range();range.selectNodeContents(root);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  const observer=new MutationObserver(()=>{});observer.observe(root,{childList:true,subtree:true,characterData:true});
  document.execCommand('bold');const records=observer.takeRecords().map(r=>({type:r.type,target:r.target.nodeName,added:[...r.addedNodes].map(n=>n.nodeName),removed:[...r.removedNodes].map(n=>n.nodeName),prev:r.previousSibling?.nodeName,next:r.nextSibling?.nodeName}));
  return {html:root.innerHTML,measurement:index.measure(),records};
 });
 expect(result.measurement.length,JSON.stringify(result)).toBe(5);
});
