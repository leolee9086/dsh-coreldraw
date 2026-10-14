import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeTarget } from '../src/bridge.js';
import { validate } from '../src/index.js';
const doc = { document_id: 'a'.repeat(32), expected_revision: 0, snapshot_token: 'b'.repeat(64) };
test('Electron selects its own ABI family, never the embedded Node binary', () => {
  assert.equal(runtimeTarget({ electron: '44.0.0', node: '24.0.0', modules: '149' }, 'win32', 'x64').package, 'electron-edge-js');
  assert.equal(runtimeTarget({ node: '24.0.0', modules: '137' }, 'win32', 'x64').package, 'edge-js');
  assert.throws(() => runtimeTarget({ node: '24.0.0' }, 'linux', 'x64'), /Windows/);
});
test('reject invalid batches before any COM mutation can start', () => {
  const run = operations => validate('apply', { ...doc, operations });
  assert.throws(() => run([{ op: 'rectangle', x: 1, y: 2, width: -1, height: 3 }]), /width/);
  assert.throws(() => run([{ op: 'delete' }]), /shape_id/);
  assert.throws(() => run([{ op: 'fill', shape_id: '12', rgb: [255, -1, 3] }]), /rgb/);
  assert.throws(() => run([{ op: 'move', shape_id: '12', x: Infinity, y: 0 }]), /finite/);
  assert.throws(() => run([{ op: 'execute_macro' }]), /Unsupported/);
  assert.throws(() => validate('apply', { ...doc, snapshot_token: '', operations: [] }), /snapshot_token/);
  assert.equal(run([{ op: 'text', x: 0, y: 0, width: 30, height: 10, text: '中文' }]).operations[0].text, '中文');
});
test('output paths reject drive-relative, device namespace, ADS and wrong extension', () => {
  for (const path of ['C:demo.cdr', 'demo.cdr', '\\\\?\\C:\\demo.cdr', 'C:\\demo.cdr:hidden.cdr', 'C:\\demo.svg']) {
    assert.throws(() => validate('save', { document_id: doc.document_id, path }));
  }
  assert.equal(validate('save', { document_id: doc.document_id, path: 'D:\\作品\\测试.cdr' }).overwrite, false);
});
test('instance selection rejects ambiguous or malformed requests before COM', () => {
  for (const pid of [0, -1, 1.5, '123', 2147483648]) assert.throws(() => validate('connect', { pid }), /pid/);
  assert.throws(() => validate('connect', { instance_id: '123:456' }), /requires pid/);
  assert.throws(() => validate('connect', { pid: 123, instance_id: 'garbage' }), /identity/);
  assert.throws(() => validate('connect', { pid: 123, launch: true }), /launch/);
  assert.throws(() => validate('connect', { launch: 'false' }), /boolean/);
  assert.deepEqual(validate('connect', { pid: 123, instance_id: '123:456' }), { pid: 123, instance_id: '123:456' });
});
