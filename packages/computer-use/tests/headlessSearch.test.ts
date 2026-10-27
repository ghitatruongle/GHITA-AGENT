import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { HeadlessSearchScanner } from '../src/scanner/headlessSearch.js';

describe('HeadlessSearchScanner', () => {
  const testDir = path.resolve(process.cwd(), 'packages/computer-use/tests/temp-test-dir');
  const sampleFilePath = path.join(testDir, 'SampleClass.ts');

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const fileContent = `import { useState } from 'react';
import type { Point } from '../types.js';
// Đây là comment một dòng ở đầu tệp
/*
  Đây là comment đa dòng ở đầu tệp
  Nó mô tả một Class mẫu
*/

export class SampleClass {
  private point: Point;

  constructor() {
    this.point = { x: 0, y: 0 };
  }

  // Khởi chạy tác vụ chính
  public execute() {
    console.log("Starting execution...");
    if (true) {
      const x = 10;
      const y = 20;
      this.point = {
        x,
        y
      };
    }
  }

  public getPoint() {
    return this.point;
  }
}
`;
    fs.writeFileSync(sampleFilePath, fileContent, 'utf-8');
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should find keyword and extract surrounding lines (sliding window)', async () => {
    const scanner = new HeadlessSearchScanner({
      range: 3,
      balanceBrackets: false,
      removeComments: false,
    });
    const result = await scanner.searchFile(sampleFilePath, 'execute');

    expect(result.found).toBe(true);
    expect(result.startLine).toBe(14); // 1-based line for constructor closed brace plus empty line and method declaration
    expect(result.endLine).toBe(20); // surrounding lines
    expect(result.content).toContain('public execute()');
  });

  it('should balance brackets using Sliding Window Bracket Balancer', async () => {
    const scanner = new HeadlessSearchScanner({
      range: 2,
      balanceBrackets: true,
      removeComments: false,
    });
    const result = await scanner.searchFile(sampleFilePath, 'this.point = {');

    expect(result.found).toBe(true);

    expect(result.content).toContain('this.point = {');

    const openBraces = (result.content.match(/{/g) || []).length;
    const closeBraces = (result.content.match(/}/g) || []).length;
    expect(openBraces).toBe(closeBraces);
  });

  it('should remove single-line & multi-line comments and import headers', () => {
    const scanner = new HeadlessSearchScanner();
    const rawContent = `import { Point } from './types';
// Line comment
/* Multi-line
comment */
const x = 'http://test.com'; // inline comment but url inside
console.log(x);`;

    const cleaned = scanner.removeCommentsAndHeaders(rawContent);
    expect(cleaned).not.toContain('import { Point }');
    expect(cleaned).not.toContain('Line comment');
    expect(cleaned).not.toContain('Multi-line');
    expect(cleaned).toContain("const x = 'http://test.com';");
    expect(cleaned).toContain('console.log(x);');
  });

  it('should compress and decompress context properly using zlib', () => {
    const scanner = new HeadlessSearchScanner();
    const text = 'Ghita Agent'.repeat(50);
    const compressed = scanner.compressContext(text);
    expect(compressed.length).toBeLessThan(Buffer.byteLength(text));

    const decompressed = scanner.decompressContext(compressed);
    expect(decompressed).toBe(text);
  });

  it('should throw error when file exceeds max size limit', async () => {
    const scanner = new HeadlessSearchScanner({ maxFileSize: 10 });
    await expect(scanner.searchFile(sampleFilePath, 'execute')).rejects.toThrow('exceeds limit');
  });

  it('should throw error for excluded extensions', async () => {
    const scanner = new HeadlessSearchScanner();
    const binaryFilePath = path.join(testDir, 'test.png');
    fs.writeFileSync(binaryFilePath, 'fake-binary-data');

    await expect(scanner.searchFile(binaryFilePath, 'fake')).rejects.toThrow(
      'excluded from headless search',
    );
  });
});
