// Exercises real Windows/Corel discovery without creating or saving documents.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { CorelBridge } from '../src/bridge.js';
const bridge = new CorelBridge();
try {
  const before = await bridge.call('instances');
  assert.ok(before.instances.length, 'Open CorelDRAW before this read-only smoke test');
  if (before.instances.length > 1) await assert.rejects(bridge.call('connect'), /Multiple CorelDRAW/);
  const requested = process.env.CORELDRAW_TEST_PID;
  const target = before.instances.find(item => item.connectable && (!requested || item.pid === Number(requested)));
  assert.ok(target, 'Requested CorelDRAW instance is not COM-accessible in this execution context');
  await assert.rejects(bridge.call('connect', { pid: target.pid, instance_id: `${target.pid}:0` }), /identity changed/);
  const connected = await bridge.call('connect', { pid: target.pid, instance_id: target.instance_id });
  assert.equal(connected.instance.instance_id, target.instance_id);
  const docs = await bridge.call('documents');
  assert.ok(docs.documents.length, 'Open a document before this read-only smoke test');
  const inspections = [];
  for (const doc of docs.documents) {
    const page = await bridge.call('inspect', { document_id: doc.document_id });
    assert.equal(page.document_id, doc.document_id);
    inspections.push({ name: page.name, shape_count: page.page.shapes.length, text_samples: page.page.shapes.filter(s => s.text).map(s => s.text).slice(0, 4) });
  }
  // A failed selection must leave the existing connection and document IDs intact.
  await assert.rejects(bridge.call('connect', { pid: 2147483647 }), /not present/);
  assert.deepEqual((await bridge.call('documents')).documents.map(d => d.document_id), docs.documents.map(d => d.document_id));
  const unavailable = before.instances.find(item => !item.connectable);
  if (unavailable) await assert.rejects(bridge.call('connect', { pid: unavailable.pid, instance_id: unavailable.instance_id }), /not accessible/);
  assert.deepEqual((await bridge.call('instances')).instances.map(i => i.instance_id), before.instances.map(i => i.instance_id));
  const report = { complete: true, runtime: bridge.artifacts.runtime, abi: bridge.artifacts.abi, instance: connected.instance, inspections };
  if (process.env.CORELDRAW_DISCOVERY_REPORT) writeFileSync(process.env.CORELDRAW_DISCOVERY_REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  console.log('DSH_CORELDRAW_DISCOVERY_COMPLETE');
} finally { await bridge.dispose(); }
