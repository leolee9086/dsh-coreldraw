import { win32 as path } from 'node:path';
import { absoluteWindowsPath } from './assets.js';
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = description => ({ type: 'string', description });
const bool = description => ({ type: 'boolean', description });
export const catalogueParameters = object({
  document_id: str('Document ID from corel_documents'),
  path: str('Absolute Windows path of the JSON catalogue to write'),
  page: { type: 'integer', minimum: 1 },
  include_text: bool('Read up to 4000 characters per text object; defaults false'),
  overwrite: bool('Explicitly replace an existing catalogue file'),
  max_shapes: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Refuse to write a catalogue larger than this many shapes' },
}, ['document_id', 'path']);

// Every later crop cites this file by shape ID and millimetre box, so the
// destination is checked as strictly as an export path: absolute, .json, and
// nothing implicit about replacing an existing catalogue.
export function validateCatalogue(args) {
  args.path = absoluteWindowsPath(args.path);
  if (path.extname(args.path).toLowerCase() !== '.json') throw new Error('path must end with .json');
  for (const key of ['include_text', 'overwrite']) if (args[key] !== undefined && typeof args[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  if (args.page !== undefined && (!Number.isInteger(args.page) || args.page < 1 || args.page > 100000)) throw new Error('page must be an integer in 1..100000');
  if (args.max_shapes !== undefined && (!Number.isInteger(args.max_shapes) || args.max_shapes < 1 || args.max_shapes > 1000000)) throw new Error('max_shapes must be an integer in 1..1000000');
  return args;
}
