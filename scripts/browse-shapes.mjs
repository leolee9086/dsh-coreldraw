// Read a whole top-level catalogue through the production bounded API.
// This neither selects nor changes artwork. Pass a PID, then an optional output.
import {writeFileSync} from 'node:fs';
import {CorelBridge} from '../src/bridge.js';
import {validate} from '../src/index.js';
const bridge=new CorelBridge();
try {
 const instances=await bridge.call('instances');
 const target=instances.instances.find(i=>i.pid===Number(process.argv[2])&&i.connectable);
 if(!target) throw new Error('Target COM instance inaccessible in this security context');
 await bridge.call('connect',{pid:target.pid,instance_id:target.instance_id});
 const docs=await bridge.call('documents');
 if(docs.documents.length!==1) throw new Error('This diagnostic requires exactly one open document');
 const doc=docs.documents[0];const shapes=[];let offset=0,page;
 do {
  const batch=await bridge.call('shapes',validate('shapes',{document_id:doc.document_id,offset,limit:100,include_text:true,...(page?{page}:{})}));
  page=batch.page;shapes.push(...batch.shapes);offset=batch.next_offset;
  console.log(JSON.stringify({read:shapes.length,total:batch.total,elapsed_ms:batch.elapsed_ms,next:offset}));
 } while(offset!==null);
 const result={document:doc,page,unit:'mm',coordinates:'page_top_left',shapes};
 writeFileSync(process.argv[3]??'artifacts/exhibition-shapes.json',JSON.stringify(result,null,2));
 console.log(JSON.stringify({complete:true,count:shapes.length,large_shapes:shapes.filter(s=>s.width>2000&&s.height>1000)}));
} finally {await bridge.dispose();}
