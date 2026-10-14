// Read-only discovery in the caller's actual Windows security context.
import { CorelBridge } from '../src/bridge.js';
const bridge = new CorelBridge();
try {
  const result = await bridge.call('instances');
  console.log(JSON.stringify({ runtime: bridge.artifacts.runtime, abi: bridge.artifacts.abi, ...result }, null, 2));
} finally { await bridge.dispose(); }
