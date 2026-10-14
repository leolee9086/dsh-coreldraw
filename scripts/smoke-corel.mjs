import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CorelBridge } from '../src/bridge.js';
import { validate } from '../src/index.js';
const bridge = new CorelBridge();
const directory = resolve(process.argv[2] ?? `artifacts/corel-${Date.now()}`);
mkdirSync(directory, { recursive: true });
const call = (action, args = {}) => bridge.call(action, validate(action, args), { timeoutMs: 120000 });
const history = [];
try {
  history.push(await call('connect', { launch: true }));
  const before = await call('documents'); history.push(before);
  let doc = await call('create', { width: 100, height: 80 });
  const identity = { document_id: doc.document_id };
  const precondition = () => ({ ...identity, expected_revision: doc.revision, snapshot_token: doc.snapshot_token });
  doc = await call('apply', { ...precondition(), label: 'dsh-coreldraw installation test', operations: [
    { op: 'rectangle', x: 10, y: 10, width: 30, height: 20, name: '安装验证矩形', rgb: [35, 120, 210] },
    { op: 'ellipse', x: 50, y: 10, width: 20, height: 20, name: 'Installation ellipse', rgb: [240, 140, 30] },
    { op: 'text', x: 10, y: 40, width: 80, height: 20, text: 'CorelDRAW 安装验证', font_size: 14 },
  ] });
  writeFileSync(join(directory, 'drawing.json'), JSON.stringify(doc, null, 2));
  assert.equal(doc.page.shapes.length, 3);
  assert.ok(doc.page.shapes.some(s => s.text?.includes('安装验证')));
  const rect = doc.page.shapes.find(s => s.name === '安装验证矩形');
  assert.equal(rect.width, 30); assert.equal(rect.height, 20);
  assert.ok(Math.abs(rect.x - 10) < 0.001 && Math.abs(rect.y - 10) < 0.001);
  const old = precondition();
  doc = await call('apply', { ...old, operations: [{ op: 'move', shape_id: rect.shape_id, x: 15, y: 15 }] });
  await assert.rejects(call('apply', { ...old, operations: [{ op: 'delete', shape_id: rect.shape_id }] }), /changed/);
  doc = await call('undo', precondition());
  assert.ok(Math.abs(doc.page.shapes.find(s => s.shape_id === rect.shape_id).x - 10) < 0.001);
  history.push(doc);
  history.push(await call('save', { ...identity, path: join(directory, 'installation-test.cdr') }));
  for (const format of ['png', 'svg', 'pdf']) history.push(await call('export', { ...identity, format, path: join(directory, `installation-test.${format}`) }));
  const after = await call('documents');
  assert.equal(after.documents.length, before.documents.length + 1);
  writeFileSync(join(directory, 'report.json'), JSON.stringify({ complete: true, history, after }, null, 2));
  console.log(JSON.stringify({ complete: true, directory, document_id: doc.document_id }));
} finally { await bridge.dispose(); }
console.log('DSH_CORELDRAW_SMOKE_COMPLETE');
