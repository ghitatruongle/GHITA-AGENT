import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const shimPath = path.resolve(__dirname, 'src/shims.ts');

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [
      {
        find: /^(node:)?(fs|path|os|crypto|url|net|tls|http|https|child_process|util|events|readline|stream|buffer|string_decoder|zlib|inspector|diagnostics_channel|worker_threads|module|timers|dns|process)(\/.*)?$/,
        replacement: shimPath,
      },
      { find: /^better-sqlite3$/, replacement: shimPath },
      { find: /^ioredis$/, replacement: shimPath },
      { find: /^@dqbd\/tiktoken$/, replacement: shimPath },
      { find: /^js-tiktoken$/, replacement: shimPath },
      { find: /^web-tree-sitter$/, replacement: shimPath },
      { find: /^@grpc\/.*$/, replacement: shimPath },
      { find: /^@sentry.*$/, replacement: shimPath },
      { find: /^@opentelemetry\/.*$/, replacement: shimPath },
      { find: /^@ghita\/native-bridge$/, replacement: shimPath },
      { find: /^@ghita\/browser-control$/, replacement: shimPath },
      { find: /^@ghita\/computer-use$/, replacement: shimPath },
      { find: /^ws$/, replacement: shimPath },
      // Native/Node-only modules reached via dynamic imports in workspace
      // packages (ai-engine grounding, communication telepresence, sidecar
      // helpers). The browser bundle must never pull their Node graphs in —
      // sharp 0.35.5 alone broke the build on node:os's availableParallelism.
      // These code paths only ever run in the Node sidecar.
      { find: /^sharp$/, replacement: shimPath },
      { find: /^node-pty$/, replacement: shimPath },
      { find: /^screenshot-desktop$/, replacement: shimPath },
    ],
  },

  // Tauri expects a fixed port
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },

  // Prevent vite from obscuring rust errors
  clearScreen: false,

  // Environment variables starting with TAURI_ will be exposed
  envPrefix: ['VITE_', 'TAURI_'],

  // Pre-bundle heavy deps so Tauri WebView doesn't get a mid-session reload
  optimizeDeps: {
    esbuildOptions: {
      target: 'esnext',
    },
    exclude: [
      '@ghita/browser-control',
      '@ghita/computer-use',
      '@ghita/ai-engine',
      '@ghita/communication',
      '@ghita/agents',
      '@ghita/skills',
      '@ghita/monitoring',
      '@ghita/quotas',
      '@sentry/node-core',
      '@sentry/node',
      '@opentelemetry/api',
      '@grpc/grpc-js',
      '@grpc/proto-loader',
      'playwright',
      'playwright-core',
      'sharp',
      'screenshot-desktop',
      'socket.io',
    ],
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react-error-boundary',
      'react-hot-toast',
      'zustand',
      'zustand/middleware',
      '@tauri-apps/api/core',
      '@tauri-apps/api/event',
      '@tauri-apps/api/window',
      '@tauri-apps/plugin-dialog',
      '@monaco-editor/react',
      'monaco-editor',
      'socket.io-client',
    ],
  },

  build: {
    // Tauri uses Chromium on Windows and WebKit on Linux/macOS
    target: process.env.TAURI_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: Boolean(process.env.TAURI_DEBUG),
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-dom/client'],
          'tauri-vendor': ['@tauri-apps/api/window', '@tauri-apps/plugin-dialog'],
          'state-vendor': ['zustand', 'react-error-boundary', 'react-hot-toast'],
          'socket-vendor': ['socket.io-client'],
          // Markdown rendering is heavy (react-markdown + rehype-sanitize + remark-gfm);
          // split it out so chat UI loads fast.
          'markdown-vendor': ['react-markdown', 'rehype-sanitize', 'remark-gfm'],
          // v0.4.9 B1: Monaco editor and xterm are large, independently-loaded
          // vendors. Splitting them keeps the initial app shell small so the
          // Tauri WebView paints fast on Windows cold start.
          'monaco-vendor': ['@monaco-editor/react', 'monaco-editor'],
          'xterm-vendor': ['@xterm/xterm', '@xterm/addon-fit'],
        },
      },
    },
    // 4 MB covers the code-graph dynamic chunk (tree-sitter WASM ~3 MB);
    // smaller chunks split cleanly into the manualChunks groups.
    chunkSizeWarningLimit: 4000,
  },
});
