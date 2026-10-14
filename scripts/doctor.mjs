import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { CorelBridge } from '../src/bridge.js';
const before = { native: process.env.EDGE_NATIVE, compiler: process.env.EDGE_CS_NATIVE };
const bridge = new CorelBridge();
try {
  const results = await Promise.all(Array.from({ length: 12 }, () => bridge.call('doctor')));
  assert.ok(results.every(v => v.apartment === 'STA'));
  assert.equal(new Set(results.map(v => v.thread_id)).size, 1);
  assert.equal(process.env.EDGE_NATIVE, before.native);
  assert.equal(process.env.EDGE_CS_NATIVE, before.compiler);
  for (const name of ['edge_nativeclr.node', 'edge-cs.dll', 'edge-cs-base.dll', 'vcruntime140.dll', 'msvcp140.dll']) {
    assert.ok(existsSync(`${bridge.artifacts.directory}/${name}`), `missing staged ${name}`);
  }
  console.log(JSON.stringify({ runtime: bridge.artifacts.runtime, abi: bridge.artifacts.abi, ...results[0], compiler: bridge.artifacts.compiler }));
} finally { await bridge.dispose(); }
console.log('DSH_CORELDRAW_DOCTOR_COMPLETE');
// GUI executable launches may detach stdout. A caller-supplied unique report
// proves completion in that exact runtime, rather than trusting exit code zero.
if (process.env.CORELDRAW_DOCTOR_REPORT) writeFileSync(process.env.CORELDRAW_DOCTOR_REPORT, JSON.stringify({ complete: true, runtime: bridge.artifacts.runtime, abi: bridge.artifacts.abi }));
