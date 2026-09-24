import assert from 'node:assert/strict';
import test from 'node:test';
import { NumericTextIndex, applyNumericTextInput } from '../packages/browser-capture/src/numeric-text-index.ts';
const verify=(index,text)=>{assert.equal(index.length,[...text].length);for(let p=0;p<=text.length;p++)assert.equal(index.offset(p),[...text.slice(0,p)].length,`offset ${p}`);};
test('numeric index preserves codepoint coordinates across split/joined surrogate boundaries',()=>{
 let text='a🙂b𐀀c';const index=new NumericTextIndex(text);verify(index,text);
 for(const [start,end,insert] of [[2,2,'x'],[2,3,''],[0,1,'🦉'],[3,5,'\ud800'],[0,2,''],[1,3,'\udfff'],[0,0,'abc']]){
  text=text.slice(0,start)+insert+text.slice(end);index.replace(text,start,end);verify(index,text);
 }
});
test('numeric index matches full measurements over 10000 arbitrary UTF-16 splices',()=>{
 let seed=17;const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
 let text='';const index=new NumericTextIndex(text);const tokens=['a','🙂','\ud800','\udfff','xyz','🦉🙂',''];
 for(let n=0;n<10000;n++){const start=random(text.length+1),end=start+random(text.length-start+1);const insert=tokens[random(tokens.length)];text=text.slice(0,start)+insert+text.slice(end);index.replace(text,start,end);verify(index,text);}
});
test('Bible-sized ASCII common edits do not rescan unchanged text or allocate index nodes',()=>{
 let text='a'.repeat(4_000_000);const index=new NumericTextIndex(text);
 // A normal edit must use its measured span and never the full reset fallback.
 index.reset=()=>assert.fail('full document scan');
 for(let i=0;i<1000;i++){const before=text.length;text+='x';applyNumericTextInput(index,text,text.length,{length:before,start:before,end:before,inputType:'insertText',dataLength:1});}
 assert.equal(index.length,4_001_000);assert.equal(index.numericNodeCount,0);
});
