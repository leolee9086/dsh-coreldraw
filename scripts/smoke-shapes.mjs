// Real COM read-only regression for pagination and group identity checks.
import assert from 'node:assert/strict';
import {CorelBridge} from '../src/bridge.js';
const b=new CorelBridge();
try {
 const scan=await b.call('instances');
 const target=scan.instances.find(i=>i.connectable&&(!process.argv[2]||i.pid===Number(process.argv[2])));
 assert.ok(target,'Target COM instance inaccessible in this security context');
 await b.call('connect',{pid:target.pid,instance_id:target.instance_id});
 const docs=await b.call('documents');
 let chosen, first;
 for(const doc of docs.documents) {
  const batch=await b.call('shapes',{document_id:doc.document_id,limit:2});
  if(batch.total>2){chosen=doc;first=batch;break;}
 }
 assert.ok(chosen,'Open a document with at least three top-level objects');
 assert.equal(first.shapes.length,2);assert.equal(first.next_offset,2);assert.equal(first.snapshot_token,undefined);
 const second=await b.call('shapes',{document_id:chosen.document_id,page:first.page,offset:2,limit:2});
 assert.ok(second.shapes.every(s=>!first.shapes.some(t=>t.shape_id===s.shape_id)));
 const tail=await b.call('shapes',{document_id:chosen.document_id,page:first.page,offset:first.total,limit:2});
 assert.equal(tail.next_offset,null);assert.deepEqual(tail.shapes,[]);
 const group=first.shapes.find(s=>s.children_path);
 if(group) {
  const child=await b.call('shapes',{document_id:chosen.document_id,page:first.page,path:group.children_path,limit:2});
  assert.ok(child.shapes.length>0);
  const stale=structuredClone(group.children_path);stale[0].shape_id='0';
  await assert.rejects(b.call('shapes',{document_id:chosen.document_id,page:first.page,path:stale,limit:2}),/path changed/);
 }
 console.log(JSON.stringify({complete:true,runtime:b.artifacts.runtime,pid:target.pid,total:first.total,group_tested:!!group,first:first.shapes}));
 console.log('DSH_CORELDRAW_SHAPES_COMPLETE');
} finally {await b.dispose();}
