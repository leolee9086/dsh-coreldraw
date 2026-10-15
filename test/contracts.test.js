import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeTarget } from '../src/bridge.js';
import { validate } from '../src/index.js';
const doc = { document_id: 'a'.repeat(32), expected_revision: 0, snapshot_token: 'b'.repeat(64) };
test('asset export rejects escaping paths, name collisions and ambiguous crops before COM', () => {
  const asset = { name: '标题/中文主标题', shape_ids: ['958'], formats: ['png', 'svg'] };
  const base = { document_id: doc.document_id, output_dir: 'W:\\工程\\切图', assets: [asset] };
  for (const name of ['../outside', 'D:\\outside', 'bad:stream', 'CON', 'name.']) {
    assert.throws(() => validate('export_assets', { ...base, assets: [{ ...asset, name }] }));
  }
  assert.throws(() => validate('export_assets', { ...base, assets: [asset, { ...asset, name: '标题\\中文主标题' }] }), /Duplicate/);
  assert.throws(() => validate('export_assets', { ...base, assets: [{ ...asset, shape_ids: ['958', '958'] }] }), /distinct/);
  assert.throws(() => validate('export_assets', { ...base, assets: [{ ...asset, crop: { x: 0, y: 0, width: 1, height: 1 } }] }), /PNG-only/);
  const result = validate('export_assets', { ...base, dry_run: true, origin: { x: -100, y: 200 } });
  assert.equal(result.assets[0].name, '标题\\中文主标题');
  assert.equal(asset.name, '标题/中文主标题');
});
test('export range options are validated before COM', () => {
  const base = { document_id: doc.document_id, path: 'D:\\out\\area.png', format: 'png' };
  assert.throws(() => validate('export', { ...base, area: { x: 0, y: 0, width: 0, height: 10 } }), /area.width/);
  assert.throws(() => validate('export', { ...base, area: { x: 0, y: 0, width: 10, height: -1 } }), /area.height/);
  assert.throws(() => validate('export', { ...base, area: 'full' }), /area must be an object/);
  assert.throws(() => validate('export', { ...base, dpi: 10 }), /dpi/);
  assert.throws(() => validate('export', { ...base, selection: 'yes' }), /selection/);
  assert.throws(() => validate('export', { ...base, selection: true, area: { x: 0, y: 0, width: 1, height: 1 } }), /either area or selection/);
  assert.throws(() => validate('export', { ...base, path: 'D:\\out\\area.svg', format: 'svg', area: { x: 0, y: 0, width: 1, height: 1 } }), /only available for png/);
  assert.throws(() => validate('export', { ...base, path: 'D:\\out\\area.pdf', format: 'pdf', selection: true }), /PDF/);
  assert.equal(validate('export', { ...base, area: { x: 10, y: 20, width: 30, height: 40 }, dpi: 300 }).dpi, 300);
  assert.equal(validate('export', { ...base, selection: true }).selection, true);
});
test('bounded browsing validates pagination and stable group paths', () => {
  for (const args of [{limit: 0}, {limit: 101}, {offset: -1}, {offset: 0.5}, {page: 0}, {include_text: 'true'}, {path: [{index: 1, shape_id: 123}]}, {path: [{index: 0, shape_id: '123'}]}]) {
    assert.throws(() => validate('shapes', {document_id: doc.document_id, ...args}));
  }
  const args = {document_id: doc.document_id, offset: 20, limit: 10, path: [{index: 2, shape_id: '123'}]};
  assert.deepEqual(validate('shapes', args), args);
});
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
test('catalogue export validates its destination before COM', () => {
  const base = { document_id: doc.document_id, path: 'W:\\工程\\切图\\source-index.json' };
  for (const path of ['source-index.json', 'C:index.json', String.raw`\\?\C:\index.json`, String.raw`\\.\C:\index.json`, 'W:\\工程\\切图\\index.svg', 'W:\\工程\\index.json:hidden']) {
    assert.throws(() => validate('export_catalogue', { ...base, path }));
  }
  assert.throws(() => validate('export_catalogue', { ...base, page: 0 }), /page/);
  assert.throws(() => validate('export_catalogue', { ...base, include_text: 'true' }), /boolean/);
  assert.throws(() => validate('export_catalogue', { ...base, max_shapes: 0 }), /max_shapes/);
  assert.throws(() => validate('export_catalogue', { ...base, max_shapes: 1000001 }), /max_shapes/);
  const result = validate('export_catalogue', { ...base, include_text: true, max_shapes: 5000 });
  assert.equal(result.path, 'W:\\工程\\切图\\source-index.json');
  assert.equal(result.include_text, true);
  assert.equal(result.overwrite, undefined);
});
