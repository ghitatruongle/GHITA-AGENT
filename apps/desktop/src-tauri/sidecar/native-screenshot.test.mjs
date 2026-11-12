// T3.1 (v0.0.1): unit tests for the native screenshot helper (no npm dep).
import test from 'node:test';
import assert from 'node:assert/strict';
import { captureScreenJpeg} from './native-screenshot.mjs';

test('native-screenshot: rejects on non-Windows platform (injectable platform opt)', async () => {
  await assert.rejects(() => captureScreenJpeg({ platform: 'linux' }), /Windows only/);
});
