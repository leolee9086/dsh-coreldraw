// Real COM regression for area and selection export on the test document only.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {CorelBridge} from '../src/bridge.js';
import {validate} from '../src/index.js';
function pngSize(path) {
 const head=readFileSync(path).subarray(0,24);
 return {width:head.readUInt32BE(16),height:head.readUInt32BE(20)};
}
const only=process.argv[3]??'all';
const out=resolve('artifacts/export-smoke');
mkdirSync(out,{recursive:true});
const b=new CorelBridge();
try {
 const scan=await b.call('instances');
 const target=scan.instances.find(i=>i.connectable&&(!process.argv[2]||i.pid===Number(process.argv[2])));
 assert.ok(target,'Target COM instance inaccessible in this security context');
 await b.call('connect',{pid:target.pid,instance_id:target.instance_id});
 const docs=await b.call('documents');
 const doc=docs.documents.find(d=>d.file_name.toLowerCase().endsWith('installation-test.cdr'));
 assert.ok(doc,'Test document installation-test.cdr is not open; refusing to touch another document');
 const report={runtime:b.artifacts.runtime,pid:target.pid,document:doc.file_name};
 if(only!=='selection') {
  const run=async(name,args)=>{
   const path=join(out,`${name}.png`);
   const result=await b.call('export',validate('export',{document_id:doc.document_id,path,format:'png',overwrite:true,...args}));
   return {...pngSize(path),bytes:result.bytes,name};
  };
  report.full=await run('full',{area:{x:0,y:0,width:100,height:80}});
  report.half=await run('half',{area:{x:0,y:0,width:50,height:40}});
  report.other=await run('other',{area:{x:50,y:40,width:50,height:40}});
  report.hires=await run('hires',{area:{x:0,y:0,width:50,height:40},dpi:288});
  assert.deepEqual([report.full.width,report.full.height],[377,302]);
  assert.deepEqual([report.half.width,report.half.height],[188,151]);
  assert.deepEqual([report.other.width,report.other.height],[188,151]);
  assert.ok(Math.abs(report.hires.width-report.half.width*3)<=3,'288 dpi must triple the pixel size');
  assert.ok(Math.abs(report.hires.height-report.half.height*3)<=3,'288 dpi must triple the pixel size');
  assert.notEqual(report.half.bytes,report.other.bytes,'two different areas must not produce identical files');
 }
 if(only!=='area') {
  const path=join(out,'selection.png');
  rmSync(path,{force:true});
  let result;
  try {
   const response=await b.call('export',validate('export',{document_id:doc.document_id,path,format:'png',overwrite:true,selection:true}));
   result={ok:true,...pngSize(path),bytes:response.bytes,selected:response.selected_objects};
  } catch(error) { result={ok:false,error:error.message}; }
  report.selection=result;
  if(result.ok) {
   // The bridge reports how many objects it found, so a silent empty export cannot pass.
   assert.ok(Number.isInteger(result.selected)&&result.selected>0,'a successful selection export must report the selected object count');
   assert.ok(result.width>0&&result.height>0,'a selection export must produce a nonempty image');
   // Which objects are selected belongs to the CorelDRAW session and is reset when
   // another COM client disconnects, so this test does not pin an exact pixel size.
   // smoke-assets.mjs selects explicit IDs and verifies per-asset exports.
  } else {
   assert.match(result.error,/nothing is selected/,'an empty selection must be refused with a clear message');
  }
 }
 report.complete=true;
 console.log(JSON.stringify(report));
 console.log('DSH_CORELDRAW_EXPORT_COMPLETE');
} finally {await b.dispose();}
