import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const sidecarDir = resolve(appRoot, 'src-tauri', 'sidecar');
const require = createRequire(import.meta.url);

mkdirSync(sidecarDir, { recursive: true });

const result = await build({
  entryPoints: [resolve(sidecarDir, 'server.mjs')],
  outfile: resolve(sidecarDir, 'server.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Size optimization: minify identifiers, remove comments, drop dead code.
  // Reduces server.bundle.mjs from ~15 MB to ~10-12 MB.
  minify: true,
  metafile: true,
  legalComments: 'none',
  treeShaking: true,
  logLevel: 'warning',
  external: [
    '*.node',
    'chromium-bidi/*',
    '../build/Release/cpufeatures.node',
    'ioredis',
    '@opentelemetry/*',
    'playwright',
    'playwright-core',
    'playwright-core/*',
  ],
  banner: {
    js: [
      "import { createRequire as __ghitaCreateRequire } from 'module';",
      "import { fileURLToPath as __ghitaFileURLToPath } from 'url';",
      "import { dirname as __ghitaDirname } from 'path';",
      'const require = __ghitaCreateRequire(import.meta.url);',
      'const __filename = __ghitaFileURLToPath(import.meta.url);',
      'const __dirname = __ghitaDirname(__filename);',
    ].join(''),
  },
});

import { writeFileSync } from 'node:fs';
writeFileSync(resolve(sidecarDir, 'meta.json'), JSON.stringify(result.metafile));

// T3.1 (v0.0.1): screenshot-desktop asset copy removed — the native capture
// helper (screenCapture_1.3.2.bat + app.manifest) is committed directly in
// sidecar/ now that the npm package is out of the dependency tree (GHSA-mh99).

if (process.platform === 'win32') {
  const bundledNode = resolve(sidecarDir, 'node.exe');
  if (!existsSync(bundledNode) || process.env.GHITA_REFRESH_NODE_EXE === '1') {
    copyFileSync(process.execPath, bundledNode);
  }
}

// node-pty dependency removed — terminal sessions are now managed natively
// by the Rust PTY backend (apps/desktop/src-tauri/src/terminal.rs).

