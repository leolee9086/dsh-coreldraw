// General command-line adapter for the exact same bridge action used by corel_export_assets.
// Config = { document_path, connection?, ...corel_export_assets parameters except document_id }.
import { readFileSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { CorelBridge } from '../src/bridge.js';
import { validate } from '../src/index.js';
const configPath = process.argv[2];
if (!configPath) throw new Error('Usage: node scripts/export-assets.mjs config.json [--dry-run]');
const { document_path, connection = {}, ...request } = JSON.parse(readFileSync(configPath, 'utf8'));
if (typeof document_path !== 'string' || !path.isAbsolute(document_path)) throw new Error('document_path must identify an already-open document by absolute path');
if (process.argv.includes('--dry-run')) request.dry_run = true;
// Validate before contacting Corel. Real identity is resolved below in this bridge instance.
validate('export_assets', { ...request, document_id: '0'.repeat(32) });
const bridge = new CorelBridge();
try {
  await bridge.call('connect', validate('connect', connection));
  const { documents } = await bridge.call('documents');
  const matches = documents.filter(d => path.normalize(path.join(d.file_path, d.file_name)).toLowerCase() === path.normalize(document_path).toLowerCase());
  if (matches.length !== 1) throw new Error('Expected exactly one already-open document matching document_path');
  const args = validate('export_assets', { ...request, document_id: matches[0].document_id });
  const result = await bridge.call('export_assets', args, { timeoutMs: 600000 });
  console.log(JSON.stringify(result));
} finally { await bridge.dispose(); }
