class MockClass {}

// inspector / diagnostics_channel / worker_threads / zlib / timers shims
export const Session = MockClass;
export const open = () => {};
export const close = () => {};
export const url = () => '';
export const waitForDebugger = () => {};
export const channel = () => ({
  hasSubscribers: false,
  publish: () => {},
  subscribe: () => {},
  unsubscribe: () => {},
});
export const hasSubscribers = () => false;
export const Worker = MockClass;
export const isMainThread = true;
export const parentPort = null;
export const threadId = 0;
export const workerData = null;
export const deflate = () => {};
export const inflate = () => {};
export const gzip = () => {};
export const gunzip = () => {};
export const setTimeout = globalThis.setTimeout;
export const clearTimeout = globalThis.clearTimeout;
export const setInterval = globalThis.setInterval;
export const clearInterval = globalThis.clearInterval;
export const setImmediate = (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
  globalThis.setTimeout(fn, 0, ...args);
export const clearImmediate = (id: Parameters<typeof globalThis.clearTimeout>[0]) =>
  globalThis.clearTimeout(id);

// async_hooks — Track S2 wraps token accounting in AsyncLocalStorage. The
// browser build has no async context tracking; this stand-in keeps the call
// sites working and always reports "outside a run", which is the correct
// answer for the WebView (all usage accounting happens in the sidecar).
export class AsyncLocalStorage<T = unknown> {
  private store: T | undefined;
  run<R>(store: T, callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = store;
    try {
      return callback(...args);
    } finally {
      this.store = previous;
    }
  }
  getStore(): T | undefined {
    return this.store;
  }
  enterWith(store: T): void {
    this.store = store;
  }
  exit<R>(callback: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = undefined;
    try {
      return callback(...args);
    } finally {
      this.store = previous;
    }
  }
  disable(): void {
    this.store = undefined;
  }
}
export const executionAsyncId = () => 0;
export const triggerAsyncId = () => 0;
export const createHook = () => ({
  enable: () => {},
  disable: () => {},
});
export const AsyncResource = MockClass;

// native-bridge shims
export const loadNative = <T = unknown>(_name: string, fallback?: () => T) => ({
  native: false,
  impl: fallback ? fallback() : ({} as T),
  fallbackReason: 'browser environment',
});
export const registerNative = () => {};
export const unregisterNative = () => {};
export const addonCandidates = () => [];
// Track R1: `@ghita/native-bridge` is aliased to this shim for the browser
// bundle, so its named exports must all exist here. The WebView never runs a
// PTY/sandbox/patch addon — the Node sidecar does — hence the permanent
// "unavailable" shape that callers treat as "use the JS fallback".
export const tryLoadPtyNative = () => ({
  native: false,
  impl: null,
  reason: 'browser environment',
});
export const tryRunSandboxedNative = async () => ({
  native: false,
  impl: null,
  reason: 'browser environment',
});
export const tryDetectEnforcementNative = () => ({
  native: false,
  impl: null,
  reason: 'browser environment',
});
export const tryApplyPatchNative = () => ({
  native: false,
  impl: null,
  reason: 'browser environment',
});
export const getNativeVecStore = () => null;
export const getVecDim = () => 1536;
export const isAddonBuilt = () => false;
export const NATIVE_BRIDGE_VERSION = '0.0.0-browser';

type Listener = (...args: unknown[]) => void;

export class EventEmitter {
  private listeners: Record<string, Listener[]> = {};
  on(event: string, fn: Listener) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(fn);
    return this;
  }
  once(event: string, fn: Listener) {
    const wrapped: Listener = (...args: unknown[]) => {
      this.off(event, wrapped);
      fn(...args);
    };
    return this.on(event, wrapped);
  }
  off(event: string, fn: Listener) {
    if (!this.listeners[event]) return this;
    this.listeners[event] = this.listeners[event].filter((f) => f !== fn);
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    if (!this.listeners[event]) return false;
    this.listeners[event].forEach((f) => f(...args));
    return true;
  }
  removeAllListeners(event?: string) {
    if (event) delete this.listeners[event];
    else this.listeners = {};
    return this;
  }
}

export const createInterface = () => ({
  on: () => {},
  close: () => {},
  write: () => {},
});

// fs exports
export const existsSync = () => false;
export const readFileSync = () => '';
export const writeFileSync = () => {};
export const appendFileSync = () => {};
export const mkdirSync = () => {};
export const readdirSync = () => [];
export const statSync = () => ({
  isDirectory: () => false,
  isFile: () => true,
  size: 0,
  mtimeMs: 0,
});
const browserRealpathSync = (path: string) => path;
browserRealpathSync.native = browserRealpathSync;
export const realpathSync = browserRealpathSync;
export const exists = () => false;
export const readFile = () => {};
export const writeFile = () => {};
export const rmSync = () => {};
export const unlinkSync = () => {};
export const rmdirSync = () => {};
export const copyFileSync = () => {};
export const renameSync = () => {};
export const watch = () => ({ close: () => {} });

// `node:fs/promises` also resolves to this shim (the vite alias covers
// `fs(/.*)?`), so the promise APIs are imported as *top-level* named exports by
// workspace packages — e.g. packages/security/src/scanner/engine.ts imports
// `{ readdir, readFile, realpath, stat }`. They must exist here or Rollup fails
// with `"stat" is not exported by "src/shims.ts"`. The `promises` namespace
// below stays for `import { promises } from 'node:fs'` call sites.
const browserStat = async () => ({
  isDirectory: () => false,
  isFile: () => true,
  size: 0,
  mtimeMs: 0,
});
export const stat = browserStat;
export const lstat = browserStat;
export const readdir = async () => [];
export const realpath = async (path: string) => path;
export const access = async () => {};
export const mkdtemp = async (prefix: string) => `${prefix}tmp`;
export const rm = async () => {};
export const unlink = async () => {};
export const mkdir = async () => {};
export const copyFile = async () => {};
export const rename = async () => {};

export const promises = {
  readFile: async () => '',
  writeFile: async () => {},
  mkdir: async () => {},
  readdir: async () => [],
  rm: async () => {},
  stat: async () => ({
    isDirectory: () => false,
    isFile: () => true,
    size: 0,
    mtimeMs: 0,
  }),
};

// path exports
export const sep = '/';
export const dirname = (p: string) => {
  const hasWinSep = p.includes('\\');
  const sep = hasWinSep ? '\\' : '/';
  // Handle Windows drive-letter roots (e.g., 'C:\file' → 'C:\\')
  if (hasWinSep && /^[a-zA-Z]:\\[^\\]*$/.test(p)) {
    return p.slice(0, 3); // e.g. 'C:\\'
  }
  if (hasWinSep && /^[a-zA-Z]:$/.test(p)) {
    return `${p}\\`; // e.g. 'C:\\'
  }
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 1) return sep;
  parts.pop();
  const result = parts.join(sep);
  // Preserve Windows drive letter root
  if (hasWinSep && /^[a-zA-Z]:$/.test(result)) return `${result}\\`;
  return result;
};
export const resolve = (...args: string[]) => {
  // Detect if any arg uses Windows-style paths
  const hasWindowsPath = args.some((a) => /^[a-zA-Z]:[\\/]/.test(a) || a.includes('\\'));
  if (hasWindowsPath) {
    const joined = args.filter(Boolean).join('\\');
    return joined.replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  }
  const joined = args.filter(Boolean).join('/');
  return joined.replace(/\/+/g, '/');
};
export const join = (...args: string[]) => {
  return args.filter(Boolean).join('/').replace(/\/+/g, '/');
};
export const extname = (p: string) => {
  const b = basename(p) || '';
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot) : '';
};
export const basename = (p: string) => {
  const sep = p.includes('\\') ? '\\' : '/';
  const parts = p.split(sep).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '';
};
export const relative = () => '';
export const isAbsolute = (p: string) => p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p);

// child_process exports
export const spawn = () => ({
  stdout: { on: () => {} },
  stderr: { on: () => {} },
  on: () => {},
});
export const exec = (_cmd: string, cb: (err: null, stdout: string, stderr: string) => void) => {
  if (cb) cb(null, '', '');
};
export const execSync = () => '';
export const spawnSync = () => ({ status: 0, stdout: '', stderr: '' });
export const execFileSync = () => '';
export const execFile = (
  _cmd: string,
  _args: unknown[],
  cb?: (err: null, stdout: unknown, stderr: unknown) => void,
) => {
  if (cb) cb(null, '', '');
};
export const fork = () => ({ on: () => {} });

// stream exports (browser no-op shims) — the MCP SDK's stdio client imports
// these named exports from 'node:stream'; without them rollup cannot link the
// bundle (release blocking, 2026-08-10).
class StreamMock extends EventEmitter {
  write(..._args: unknown[]) {
    return true;
  }
  end(..._args: unknown[]) {
    return this;
  }
  pipe(..._args: unknown[]) {
    return this;
  }
  pause() {
    return this;
  }
  resume() {
    return this;
  }
  destroy() {
    return this;
  }
}
export class PassThrough extends StreamMock {}
export class Readable extends StreamMock {}
export class Writable extends StreamMock {}
export class Transform extends StreamMock {}
export class Duplex extends StreamMock {}
export const Stream = StreamMock;
export const pipeline = (..._args: unknown[]) => StreamMock;
export const finished = (..._args: unknown[]) => StreamMock;

// util exports
export const promisify =
  (fn: (...args: unknown[]) => unknown) =>
  (...args: unknown[]) =>
    Promise.resolve(fn(...args));
export const inspect = (val: unknown) => String(val);
export const parseArgs = () => ({ values: {}, positionals: [] });

// crypto exports
export const createHash = () => ({
  update: () => ({
    digest: () => '',
  }),
});
export const randomUUID = () =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : (() => {
        // produced weak, non-crypto UUIDs. Use the Web Crypto API's random
        // values when available (then set the v4 bits), falling back to
        // Math.random only as a last resort.
        const bytes = new Uint8Array(16);
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(bytes);
        } else {
          for (let i = 0; i < bytes.length; i++) bytes[i] = (Math.random() * 256) | 0;
        }
        bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
        bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      })();
export const randomBytes = (size: number) => {
  const arr = new Uint8Array(size);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    // WARNING: Math.random is NOT cryptographically secure.
    // This fallback should only be used in non-security contexts.
    console.warn('[shims] randomBytes: Web Crypto unavailable, using Math.random (insecure)');
    for (let i = 0; i < size; i++) arr[i] = Math.floor(Math.random() * 256);
  }
  return {
    toString: (encoding?: string) => {
      if (encoding === 'hex') {
        return Array.from(arr)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
      }
      return String.fromCharCode(...arr);
    },
  };
};
export const timingSafeEqual = (a: Uint8Array | number[], b: Uint8Array | number[]) => {
  // Always iterate the full length to avoid timing leaks
  const len = Math.max(a.length ?? 0, b.length ?? 0);
  let result = (a.length ?? 0) !== (b.length ?? 0) ? 1 : 0;
  for (let i = 0; i < len; i++) {
    const av = i < (a.length ?? 0) ? (a[i] ?? 0) : 0;
    const bv = i < (b.length ?? 0) ? (b[i] ?? 0) : 0;
    result |= av ^ bv;
  }
  return result === 0;
};

// module exports
export const createRequire = () => (id: string) => ({ id, default: {}, __esModule: true });

// url exports
export const fileURLToPath = (url: string) => url;
export const pathToFileURL = (p: string) => ({ href: p });

// os exports
export const homedir = () => '';
export const tmpdir = () => '';
export const platform = () => 'browser';
export const arch = () => 'javascript';
export const release = () => '';

// net, tls, http, https exports
export const createServer = () => ({ listen: () => {} });
export const parse = (urlStr: string) => new URL(urlStr);
export const format = () => '';

// better-sqlite3
export const Database = MockClass;

// @grpc/proto-loader mocks
export const loadSync = () => ({});
export const load = async () => ({});
export const fromJSON = () => ({});
export const IdempotencyLevel = {};
export const isAnyExtension = () => false;
export const Long = {};
export const loadFileDescriptorSetFromBuffer = () => ({});
export const loadFileDescriptorSetFromObject = () => ({});

// @grpc/grpc-js mocks
export const Server = MockClass;
export const ServerCredentials = {
  createInsecure: () => ({}),
  createSsl: () => ({}),
};
export const loadPackageDefinition = () => ({});
export const credentials = {
  createInsecure: () => ({}),
  createSsl: () => ({}),
};
export const status = {};
export const Metadata = MockClass;

const defaultMock = {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  realpathSync,
  exists,
  readFile,
  writeFile,
  rmSync,
  unlinkSync,
  rmdirSync,
  copyFileSync,
  renameSync,
  watch,
  promises,
  dirname,
  sep,
  resolve,
  join,
  extname,
  basename,
  relative,
  isAbsolute,
  spawn,
  exec,
  execSync,
  spawnSync,
  execFileSync,
  execFile,
  fork,
  createRequire,
  promisify,
  inspect,
  parseArgs,
  createHash,
  randomUUID,
  randomBytes,
  timingSafeEqual,
  fileURLToPath,
  pathToFileURL,
  homedir,
  tmpdir,
  platform,
  arch,
  release,
  createServer,
  parse,
  format,
  Database,
  EventEmitter,
  createInterface,
  PassThrough,
  Readable,
  Writable,
  Transform,
  Duplex,
  Stream,
  pipeline,
  finished,
  loadSync,
  load,
  fromJSON,
  IdempotencyLevel,
  isAnyExtension,
  Long,
  loadFileDescriptorSetFromBuffer,
  loadFileDescriptorSetFromObject,
  Server,
  ServerCredentials,
  loadPackageDefinition,
  credentials,
  status,
  Metadata,
  Session,
  open,
  close,
  url,
  waitForDebugger,
  channel,
  hasSubscribers,
  Worker,
  isMainThread,
  parentPort,
  threadId,
  workerData,
  deflate,
  inflate,
  gzip,
  gunzip,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  loadNative,
  registerNative,
  unregisterNative,
  addonCandidates,
};

export default defaultMock;
