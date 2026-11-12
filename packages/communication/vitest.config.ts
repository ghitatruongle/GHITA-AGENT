import { defineConfig } from 'vitest/config';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      '../../tests/unit/communicationServer.test.ts',
      '../../tests/unit/channels.test.ts',
    ],
    testTimeout: 10000,
    alias: {
      'socket.io': resolve(__dirname, '../../tests/unit/socket-io-mock.ts'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/**/types.ts',
        'src/index.ts',
        // Heavy channel adapters / gateway bots need live tokens — excluded from gate.
        'src/channels/**',
        'src/gateway/**',
        'node_modules/**',
        'dist/**',
      ],
      thresholds: {
        // Wave3 measured ~44% overall; after excluding token adapters, core should be higher.
        statements: 50,
        branches: 55,
        functions: 50,
        lines: 50,
      },
    },
  },
});
