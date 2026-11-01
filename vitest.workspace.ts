import { defineWorkspace } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const commonAliases = {
  '@ghita/ai-engine': path.resolve(__dirname, 'packages/ai-engine/src/index.ts'),
  '@ghita/communication': path.resolve(__dirname, 'packages/communication/src/index.ts'),
  '@ghita/shared/node': path.resolve(__dirname, 'packages/shared/src/node.ts'),
  '@ghita/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
  '@ghita/skills/node': path.resolve(__dirname, 'packages/skills/src/node.ts'),
  '@ghita/skills': path.resolve(__dirname, 'packages/skills/src/index.ts'),
  '@ghita/agents': path.resolve(__dirname, 'packages/agents/src/index.ts'),
  '@ghita/security': path.resolve(__dirname, 'packages/security/src/index.ts'),
  '@ghita/memory': path.resolve(__dirname, 'packages/memory/src/index.ts'),
  '@ghita/code-graph': path.resolve(__dirname, 'packages/code-graph/src/index.ts'),
  '@ghita/ingest': path.resolve(__dirname, 'packages/ingest/src/index.ts'),
  '@ghita/marketplace': path.resolve(__dirname, 'packages/marketplace/src/index.ts'),
  '@ghita/relay-server': path.resolve(__dirname, 'packages/relay-server/src/index.ts'),
  '@ghita/browser-control': path.resolve(__dirname, 'packages/browser-control/src/index.ts'),
  '@ghita/computer-use': path.resolve(__dirname, 'packages/computer-use/src/index.ts'),
  '@ghita/quotas': path.resolve(__dirname, 'packages/quotas/src/index.ts'),
  'react-native-bluetooth-classic': path.resolve(
    __dirname,
    './tests/unit/react-native-bluetooth-classic-mock.ts',
  ),
  'react-native': path.resolve(__dirname, './tests/unit/react-native-mock.ts'),
  'socket.io': path.resolve(__dirname, './tests/unit/socket-io-mock.ts'),
  'screenshot-desktop': path.resolve(__dirname, './tests/unit/screenshot-desktop-mock.ts'),
};

export default defineWorkspace([
  'packages/*/vitest.config.ts',
  'apps/*/vitest.config.ts',
  {
    resolve: {
      alias: commonAliases,
    },
    test: {
      name: 'root-tests',
      include: ['tests/**/*.test.ts'],
      exclude: ['tests/e2e/playwright-*.test.ts'],
      alias: commonAliases,
      globals: true,
      environment: 'node',
      coverage: {
        provider: 'v8',
        reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
        reportsDirectory: './coverage',
        include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/*.d.ts', '**/node_modules/**', '**/dist/**'],
        thresholds: {
          statements: 50,
          branches: 45,
          functions: 50,
          lines: 50,
        },
      },
    },
  },
]);
