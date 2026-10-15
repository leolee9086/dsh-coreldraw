// Native artifacts come from our own pinned npm dependencies. Nothing resolves
// through another plugin, a global node_modules directory, or the developer tree.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const ascii = value => /^[\x20-\x7e]+$/.test(value);
export function runtimeTarget(versions = process.versions, platform = process.platform, arch = process.arch) {
  if (platform !== 'win32' || arch !== 'x64') throw new Error('dsh-coreldraw requires Windows x64 and .NET Framework 4.8.');
  const electron = versions.electron;
  return { package: electron ? 'electron-edge-js' : 'edge-js', major: (electron ?? versions.node).split('.')[0],
    runtime: electron ? `Electron ${electron}` : `Node ${versions.node}`, abi: versions.modules };
}

function stage(files, cacheRoot) {
  const hash = createHash('sha256');
  for (const [name, path] of files) hash.update(name).update(readFileSync(path));
  const target = join(cacheRoot, hash.digest('hex'));
  mkdirSync(target, { recursive: true });
  for (const [name, path] of files) {
    const destination = join(target, name);
    // Another Harness process may prepare the same content-addressed cache.
    try { copyFileSync(path, destination, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!readFileSync(destination).equals(readFileSync(path))) throw new Error(`Cache integrity failure: ${destination}`);
  }
  return target;
}

export function prepareArtifacts({ cacheDir = process.env.CORELDRAW_CACHE_DIR } = {}) {
  const target = runtimeTarget();
  let entry;
  try { entry = require.resolve(target.package); }
  catch { throw new Error(`Missing ${target.package}; install dsh-coreldraw with optional dependencies enabled (build scripts are not required).`); }
  const lib = dirname(entry);
  const nativeRoot = join(lib, 'native', 'win32', 'x64');
  const binary = join(nativeRoot, target.major, 'edge_nativeclr.node');
  if (!existsSync(binary)) throw new Error(`No bundled native bridge for ${target.runtime} (ABI ${target.abi}). Update the plugin to a release supporting this runtime; do not substitute the Node binary for Electron.`);
  const compilerRoot = dirname(createRequire(entry).resolve('edge-cs'));
  const files = [['edge_nativeclr.node', binary]];
  // The install hooks copy these DLLs but also try an unrelated CoreCLR build.
  // Stage the packaged redistributables ourselves; pnpm --ignore-scripts works.
  for (const name of ['concrt140.dll', 'msvcp140.dll', 'vccorlib140.dll', 'vcruntime140.dll']) {
    files.push([name, join(nativeRoot, name)]);
  }
  for (const name of ['edge-cs.dll', 'edge-cs-base.dll']) files.push([name, join(compilerRoot, name)]);
  const candidates = cacheDir ? [cacheDir] : [join(tmpdir(), 'dsh-coreldraw'),
    join(process.env.ProgramData ?? 'C:\\ProgramData', 'dsh-coreldraw')];
  let lastError;
  for (const candidate of candidates) {
    if (!ascii(candidate)) { lastError = new Error('The CLR compiler needs an ASCII cache path.'); continue; }
    try {
      const directory = stage(files, candidate);
      return { ...target, directory, native: join(directory, 'edge_nativeclr.node'), compiler: join(directory, 'edge-cs.dll') };
    } catch (error) { lastError = error; }
  }
  throw new Error(`Cannot prepare the native bridge. Set CORELDRAW_CACHE_DIR to a writable ASCII directory. ${lastError?.message}`);
}

export class CorelBridge {
  #raw;
  #tail = Promise.resolve();
  #disposed = false;
  #active = false;
  constructor(options = {}) { this.options = options; }
  #load() {
    if (this.#raw) return;
    const artifacts = prepareArtifacts(this.options);
    // This is the exact native initializeClrFunc API used by edge.func, pinned
    // and covered by real Node/Electron smoke tests. Supplying compiler directly
    // avoids process-wide EDGE_NATIVE / EDGE_CS_NATIVE overrides: other plugins
    // may already have their own bridge loaded in the same Harness process.
    const native = require(artifacts.native);
    const framework = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
    this.#raw = native.initializeClrFunc({
      source: ['corel.cs', 'discovery.cs', 'output.cs', 'assets.cs', 'catalogue.cs'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'),
      compiler: artifacts.compiler, typeName: 'Startup', methodName: 'Invoke',
      references: ['System.Web.Extensions.dll', 'Microsoft.CSharp.dll'].map(name => join(framework, name)),
    });
    this.artifacts = artifacts;
  }
  call(action, args = {}, { signal, timeoutMs = 60000 } = {}) {
    if (this.#disposed) return Promise.reject(new Error('CorelDRAW bridge disposed'));
    const deadline = Date.now() + timeoutMs;
    let started = false, cancelled = false;
    // Serialize on the JS side as well: an individual edge function is never
    // entered twice concurrently, including after a caller stops waiting.
    const work = this.#tail.then(async () => {
      if (cancelled || signal?.aborted || Date.now() >= deadline) throw new Error('CorelDRAW request cancelled/expired before execution (not_started)');
      this.#load();
      this.#active = true;
      started = true;
      try {
        return await new Promise((resolve, reject) => this.#raw(JSON.stringify({ ...args, action }), (error, json) => {
          if (error) return reject(error);
          try {
            const value = JSON.parse(json);
            if (!value.ok) { const failure = new Error(value.error); failure.details = value; reject(failure); }
            else resolve(value);
          } catch (error) { reject(error); }
        }));
      } finally { this.#active = false; }
    });
    this.#tail = work.catch(() => {});
    return new Promise((resolve, reject) => {
      const expired = () => {
        cancelled = true;
        reject(new Error(started
          ? 'CorelDRAW request interrupted; execution_state=unknown. The COM call may still complete. Inspect before doing anything else; do not automatically retry.'
          : 'CorelDRAW request interrupted; execution_state=not_started. The queued request will not execute.'));
      };
      const timer = setTimeout(expired, timeoutMs);
      signal?.addEventListener('abort', expired, { once: true });
      work.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', expired); });
    });
  }
  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#tail;
    if (this.#raw) await new Promise((resolve, reject) => this.#raw(JSON.stringify({ action: 'dispose' }), (error) => error ? reject(error) : resolve()));
  }
}
