import { win32 as path } from 'node:path';
const number = description => ({ type: 'number', description });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const rectangle = object({ x: number('Left edge in page-top-left mm'), y: number('Top edge in page-top-left mm'), width: number('Width in mm'), height: number('Height in mm') }, ['x', 'y', 'width', 'height']);
export const assetParameters = object({
  document_id: { type: 'string', description: 'Document ID from corel_documents' },
  page: { type: 'integer', minimum: 1 },
  output_dir: { type: 'string', description: 'Absolute Windows output directory' },
  report_path: { type: 'string', description: 'Optional absolute JSON journal path; records each completed output for recovery' },
  origin: object({ x: number('Board origin X in page-top-left mm'), y: number('Board origin Y in page-top-left mm') }, ['x', 'y']),
  dry_run: { type: 'boolean', description: 'Resolve IDs, validate selections, and return exact bounds without writing files' },
  overwrite: { type: 'boolean', description: 'Explicitly replace existing outputs and report' },
  assets: { type: 'array', minItems: 1, maxItems: 100, items: object({
    name: { type: 'string', description: 'Meaningful relative path without extension, e.g. titles/main-title' },
    shape_ids: { type: 'array', minItems: 1, maxItems: 5000, items: { type: 'string' } },
    formats: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', enum: ['png', 'svg'] } },
    dpi: { type: 'integer', minimum: 12, maximum: 1200 },
    crop: rectangle,
  }, ['name', 'shape_ids', 'formats']) },
}, ['document_id', 'output_dir', 'assets']);

// Keep path checks at the public boundary: every entry point rejects the same
// shapes, so a registered tool and the CLI cannot drift apart.
export function absoluteWindowsPath(value) {
  if (typeof value !== 'string' || !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(value) || /^\\\\[?.]\\/.test(value) || /[\x00-\x1f]/.test(value) || value.slice(2).includes(':')) throw new Error('Use an absolute Windows filesystem path without a device namespace or alternate data stream');
  return path.normalize(value);
}

export function validateAssets(args) {
  const coordinate = (v, label) => { if (!Number.isFinite(v) || Math.abs(v) > 100000) throw new Error(`${label} must be finite and within +/-100000 mm`); };
  args.output_dir = absoluteWindowsPath(args.output_dir);
  if (args.report_path !== undefined) {
    args.report_path = absoluteWindowsPath(args.report_path);
    if (path.extname(args.report_path).toLowerCase() !== '.json') throw new Error('report_path must end with .json');
  }
  for (const key of ['dry_run', 'overwrite']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.page > 100000)) throw new Error('page must be an integer in 1..100000');
  if (args.origin !== undefined) { coordinate(args.origin?.x, 'origin.x'); coordinate(args.origin?.y, 'origin.y'); }
  if (!Array.isArray(args.assets) || args.assets.length < 1 || args.assets.length > 100) throw new Error('Provide 1..100 assets');
  const names = new Set();
  for (const asset of args.assets) {
    if (!asset || typeof asset.name !== 'string' || !asset.name || asset.name.length > 240 || path.isAbsolute(asset.name)) throw new Error('Asset name must be a relative path of 1..240 characters');
    const pieces = asset.name.split(/[\\/]/);
    if (pieces.some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error('Asset name contains an unsafe path component');
    asset.name = pieces.join('\\');
    const canonical = asset.name.toLowerCase();
    if (names.has(canonical)) throw new Error('Duplicate asset name');
    names.add(canonical);
    if (!Array.isArray(asset.shape_ids) || !asset.shape_ids.length || asset.shape_ids.length > 5000 || asset.shape_ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(asset.shape_ids).size !== asset.shape_ids.length) throw new Error('shape_ids requires 1..5000 distinct numeric strings');
    if (!Array.isArray(asset.formats) || !asset.formats.length || asset.formats.length > 2 || asset.formats.some(f => !['png', 'svg'].includes(f)) || new Set(asset.formats).size !== asset.formats.length) throw new Error('formats must contain png and/or svg once');
    if (asset.dpi !== undefined && (!Number.isInteger(asset.dpi) || asset.dpi < 12 || asset.dpi > 1200)) throw new Error('dpi must be an integer in 12..1200');
    if (asset.crop !== undefined) {
      if (!asset.formats.includes('png') || asset.formats.includes('svg')) throw new Error('Explicit crop is supported for PNG-only assets; SVG preserves full selection bounds');
      for (const key of ['x', 'y', 'width', 'height']) coordinate(asset.crop?.[key], `crop.${key}`);
      if (asset.crop.width <= 0 || asset.crop.height <= 0) throw new Error('crop dimensions must be positive');
    }
  }
  return args;
}
