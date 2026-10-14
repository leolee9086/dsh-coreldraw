import { CorelBridge } from '../src/bridge.js';
const bridge = new CorelBridge();
try {
  const docs = await bridge.call('documents');
  console.log(JSON.stringify(docs));
  for (const doc of docs.documents) console.log(JSON.stringify(await bridge.call('inspect', { document_id: doc.document_id })));
} finally { await bridge.dispose(); }
