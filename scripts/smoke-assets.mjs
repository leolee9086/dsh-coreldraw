// Real integration test against an explicitly named, already-open document.
// Usage: node scripts/smoke-assets.mjs config.json
// Uses the CLI configuration shape, but requires a fresh output_dir. Does not
// save, close, copy or edit artwork. Keep project-specific IDs outside this repo.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { createHash } from 'node:crypto';
import { CorelBridge } from '../src/bridge.js';
import { validate } from '../src/index.js';
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/smoke-assets.mjs config.json');
const { document_path, connection = {}, ...request } = JSON.parse(readFileSync(configPath, 'utf8'));
validate('export_assets', { ...request, document_id: '0'.repeat(32) });
assert.ok(typeof document_path === 'string' && path.isAbsolute(document_path), 'Specify the full path of an open document');
assert.equal(existsSync(request.output_dir), false, 'Smoke output directory must be new');
mkdirSync(request.output_dir, { recursive: true });
const bridge = new CorelBridge();
const call = (action, args) => bridge.call(action, validate(action, args), { timeoutMs: 300000 });
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
try {
  await call('connect', connection);
  const before = await call('documents', {});
  const matches = before.documents.filter(d => path.normalize(path.join(d.file_path, d.file_name)).toLowerCase() === path.normalize(document_path).toLowerCase());
  assert.equal(matches.length, 1, 'Expected exactly one open document at document_path');
  const document_id = matches[0].document_id;
  const indexPath = path.join(request.output_dir, 'catalogue.json');
  const catalogue = await call('export_catalogue', { document_id, path: indexPath });
  let hash = digest(indexPath);
  await assert.rejects(call('export_catalogue', { document_id, path: indexPath }), /Destination exists/);
  assert.equal(digest(indexPath), hash, 'Refusing overwrite must preserve the catalogue');
  if (catalogue.total > 1) {
    await assert.rejects(call('export_catalogue', { document_id, path: indexPath, overwrite: true, max_shapes: 1 }), /Catalogue exceeds/);
    assert.equal(digest(indexPath), hash, 'A failed catalogue must preserve the previous file');
  }
  await call('export_catalogue', { document_id, path: indexPath, overwrite: true });
  assert.equal(digest(indexPath), hash, 'Repeated live catalogue should match while the drawing is idle');
  const args = { ...request, document_id, overwrite: false, report_path: path.join(request.output_dir, 'exports.json') };
  const listing = readdirSync(request.output_dir);
  const dry = await call('export_assets', { ...args, dry_run: true });
  assert.equal(dry.complete, true);
  assert.deepEqual(readdirSync(request.output_dir), listing, 'dry_run must not write outputs');
  const exported = await call('export_assets', { ...args, dry_run: false });
  assert.equal(exported.complete, true);
  assert.equal(JSON.parse(readFileSync(args.report_path, 'utf8')).complete, true);
  assert.equal(exported.assets.length, request.assets.length);
  const outputs = exported.assets.flatMap(row => row.files);
  const hashes = outputs.map(file => digest(file.path));
  for (const file of outputs) {
    const bytes = readFileSync(file.path);
    if (file.format === 'png') {
      assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
      assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
      assert.ok(bytes[25] === 6 || bytes[25] === 4, 'Transparent PNG must have an alpha channel');
    } else assert.match(bytes.toString('utf8'), /<svg\b/);
  }
  await assert.rejects(call('export_assets', args), /Destination exists/);
  assert.deepEqual(outputs.map(file => digest(file.path)), hashes, 'Refusing overwrite must preserve asset files');
  const afterPath = path.join(request.output_dir, 'catalogue-after.json');
  await call('export_catalogue', { document_id, path: afterPath });
  assert.equal(digest(afterPath), hash, 'Asset export must preserve catalogue geometry, fill, names and nesting');
  const after = await call('documents', {});
  assert.deepEqual(after.documents, before.documents, 'Export must not add, close or save a document');
  assert.ok(readdirSync(request.output_dir).every(name => !name.startsWith('.dsh-corel-')), 'No temporary JSON files may remain');
  const result = { complete: true, runtime: bridge.artifacts.runtime, catalogue_objects: catalogue.total, assets: exported.assets.length, files: outputs.length, directory: request.output_dir };
  writeFileSync(path.join(request.output_dir, 'smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally { await bridge.dispose(); }
console.log('DSH_CORELDRAW_ASSETS_COMPLETE');
