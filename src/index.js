import { win32 as path } from 'node:path';
import { CorelBridge } from './bridge.js';

export const name = 'dsh-coreldraw';
export const inject = ['tools'];
const str = description => ({ type: 'string', description });
const num = description => ({ type: 'number', description });
const bool = description => ({ type: 'boolean', description });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const documentId = str('Document ID returned by corel_documents or corel_create; bound to the actual open COM document.');
const snapshot = { document_id: documentId, expected_revision: { type: 'integer' }, snapshot_token: str('Token returned by the latest inspect/apply; detects changes in observed page content.') };
const operationSchema = object({
  op: { type: 'string', enum: ['rectangle', 'ellipse', 'text', 'set_text', 'move', 'resize', 'rotate', 'fill', 'delete'] },
  shape_id: str('StaticID from inspection, required for edits to existing shapes.'),
  x: num('Left coordinate in mm'), y: num('Top coordinate in mm'), width: num('Width in mm'), height: num('Height in mm'),
  text: str('Text content'), font: str('Installed font family'), font_size: num('Font size in points'),
  angle: num('Absolute rotation in degrees'), name: str('Shape name'),
  rgb: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, minItems: 3, maxItems: 3 },
}, ['op']);

// The schema helps discovery; these checks also protect direct API consumers.
export function validate(action, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Arguments must be an object');
  const args = structuredClone(value);
  const positive = (item, key) => { if (!Number.isFinite(item[key]) || item[key] <= 0 || item[key] > 100000) throw new Error(`${key} must be finite and in (0, 100000]`); };
  const finite = (item, key) => { if (!Number.isFinite(item[key]) || Math.abs(item[key]) > 100000) throw new Error(`${key} must be finite and between -100000 and 100000`); };
  const string = (item, key) => { if (typeof item[key] !== 'string' || item[key].length > 100000) throw new Error(`${key} must be a string of at most 100000 characters`); };
  if (action === 'connect' && args.prog_id !== undefined && !/^CorelDRAW\.Application(?:\.\d+)?$/i.test(args.prog_id)) throw new Error('prog_id must be CorelDRAW.Application or a versioned CorelDRAW.Application.N');
  if (['inspect', 'apply', 'undo', 'save', 'export'].includes(action)) {
    if (typeof args.document_id !== 'string' || !/^[0-9a-f]{32}$/.test(args.document_id)) throw new Error('Invalid document_id');
  }
  if (['apply', 'undo'].includes(action)) {
    if (!Number.isSafeInteger(args.expected_revision) || args.expected_revision < 0) throw new Error('expected_revision must be a nonnegative integer');
    if (!/^[0-9a-f]{64}$/.test(args.snapshot_token ?? '')) throw new Error('snapshot_token is required; inspect the document first');
  }
  if (action === 'create') { positive(args, 'width'); positive(args, 'height'); }
  if (action === 'apply') {
    if (!Array.isArray(args.operations) || args.operations.length < 1 || args.operations.length > 100) throw new Error('Provide 1..100 operations');
    if (args.label !== undefined && (typeof args.label !== 'string' || args.label.length > 120)) throw new Error('label must be at most 120 characters');
    for (const op of args.operations) {
      if (!op || !operationSchema.properties.op.enum.includes(op.op)) throw new Error('Unsupported operation');
      const created = ['rectangle', 'ellipse', 'text'].includes(op.op);
      if (!created && !/^\d+$/.test(op.shape_id ?? '')) throw new Error('Existing shape operations require a numeric shape_id');
      if (created || op.op === 'resize') { positive(op, 'width'); positive(op, 'height'); }
      if (created || op.op === 'move') { finite(op, 'x'); finite(op, 'y'); }
      if (op.op === 'text' || op.op === 'set_text') string(op, 'text');
      if (op.op === 'rotate') finite(op, 'angle');
      if (op.font_size !== undefined) positive(op, 'font_size');
      for (const key of ['font', 'name']) if (op[key] !== undefined) string(op, key);
      if (op.op === 'fill' && op.rgb === undefined) throw new Error('fill requires rgb');
      if (op.rgb !== undefined && (!Array.isArray(op.rgb) || op.rgb.length !== 3 || op.rgb.some(v => !Number.isInteger(v) || v < 0 || v > 255))) throw new Error('rgb requires three integers in 0..255');
    }
  }
  if (action === 'save' || action === 'export') {
    const extension = action === 'save' ? 'cdr' : args.format;
    if (!['cdr', 'png', 'svg', 'pdf'].includes(extension)) throw new Error('Unsupported output format');
    // Reject relative/drive-relative paths and device namespaces before COM sees them.
    if (typeof args.path !== 'string' || !/^(?:[a-z]:\\|\\\\[^\\]+\\[^\\]+\\)/i.test(args.path) || /^\\\\[?.]\\/.test(args.path) || /[\x00-\x1f]/.test(args.path)) throw new Error('Use an absolute Windows output path');
    args.path = path.normalize(args.path);
    if (path.extname(args.path).toLowerCase() !== `.${extension}` || args.path.slice(2).includes(':')) throw new Error(`Output path must end with .${extension} and cannot contain an alternate data stream`);
    args.overwrite = args.overwrite === true;
  }
  return args;
}

export function definitions() {
  return [
    ['corel_connect', 'connect', 'Connect to CorelDRAW COM. Default attaches only; launch:true explicitly starts CorelDRAW. Reports actual version.', object({ launch: bool('Explicitly allow starting CorelDRAW'), prog_id: str('Default CorelDRAW.Application; may specify CorelDRAW.Application.24') })],
    ['corel_documents', 'documents', 'List open CorelDRAW documents and get stable IDs. Does not launch the application.', object({})],
    ['corel_create', 'create', 'Create a new blank CorelDRAW document, sized in mm.', object({ width: num('Page width in mm'), height: num('Page height in mm') }, ['width', 'height'])],
    ['corel_inspect', 'inspect', 'Inspect the active page of the specified document, including nested groups, geometry and text. Returns revision and snapshot token for editing; max 5000 shapes.', object({ document_id: documentId }, ['document_id'])],
    ['corel_apply', 'apply', 'Apply 1..100 operations as one CorelDRAW undo group. Positions are page-top-left millimetres. Requires latest inspection token and revision. On error/timeout inspect again; never automatically replay.', object({ ...snapshot, label: str('Undo label (max 120 characters)'), operations: { type: 'array', items: operationSchema, minItems: 1, maxItems: 100 } }, [...Object.keys(snapshot), 'operations'])],
    ['corel_undo', 'undo', 'Undo the latest command in this document (including possible manual edits). Requires current inspection.', object(snapshot, Object.keys(snapshot))],
    ['corel_save', 'save', 'Save the specified document as an absolute .cdr path. Existing destination requires overwrite:true.', object({ document_id: documentId, path: str('Absolute .cdr path'), overwrite: bool('Allow replacing an existing file') }, ['document_id', 'path'])],
    ['corel_export', 'export', 'Export the specified document to PNG, SVG (current page) or PDF (current document PDF settings). Existing destination requires overwrite:true.', object({ document_id: documentId, path: str('Absolute output path'), format: { type: 'string', enum: ['png', 'svg', 'pdf'] }, overwrite: bool('Allow replacing an existing file') }, ['document_id', 'path', 'format'])],
  ];
}

export function apply(ctx, config = {}) {
  const observe = config.observeApproval ?? 'ask', control = config.controlApproval ?? 'ask';
  for (const policy of [observe, control]) if (!['ask', 'allow', 'deny'].includes(policy)) throw new Error('Approval policy must be ask, allow or deny');
  const timeoutMs = config.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error('timeoutMs must be 1000..300000');
  const bridge = new CorelBridge({ cacheDir: config.cacheDir });
  ctx.effect(() => () => bridge.dispose());
  for (const [toolName, action, description, parameters] of definitions()) {
    ctx.tools.register({ name: toolName, description, parameters,
      output: { schema: { type: 'string' }, render(_args, value) { return [{ type: 'text', text: value }]; } },
      async execute(raw, exec) {
        const args = validate(action, raw);
        let policy = ['documents', 'inspect'].includes(action) || (action === 'connect' && !args.launch) ? observe : control;
        // Inherit only the authoritative Full access preset; an absent service
        // or a missing agent must never silently grant control.
        if (policy === 'ask' && exec.agent?.session) {
          const presets = ctx.get('permissionPresets');
          if (presets) {
            const spec = presets.resolve(presets.current(exec.agent.session));
            if (spec?.sandbox === 'danger-full-access' && spec?.approval === 'never') policy = 'allow';
          }
        }
        if (policy === 'deny') throw new Error(`CorelDRAW ${action} denied by plugin policy`);
        if (policy === 'ask') {
          const approval = ctx.get('approval');
          if (!approval || !exec.agent) throw new Error('CorelDRAW action requires the Harness approval channel');
          const answer = await approval.request({ agent: exec.agent, toolName, callId: exec.callId, reason: `CorelDRAW ${action}${args.path ? ': ' + args.path : ''}`, signal: exec.signal });
          if (answer !== 'allowed-once') throw new Error(`CorelDRAW approval: ${answer}`);
        }
        exec.signal?.throwIfAborted();
        return JSON.stringify(await bridge.call(action, args, { signal: exec.signal, timeoutMs }));
      },
    });
  }
}
