#!/usr/bin/env node

import { readdir, readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const apiDirectory = resolve(projectRoot, 'docs/docs/api');
let changedFiles = 0;

// Docusaurus bỏ qua mọi file/thư mục bắt đầu bằng `_` (quy ước partial MDX).
// typedoc-plugin-markdown đặt module KHÔNG TÊN vào thư mục `_/`, nên toàn bộ
// link tới `_/classes/...` vỡ khi build docs. Đổi tên thành `modules` và
// rewrite link tương ứng.
const UNNAMED_MODULE_DIR = '_';
const RENAMED_MODULE_DIR = 'modules';

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(path);
      return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
    }),
  );
  return files.flat();
}

/** Đổi `_/` (một segment path) thành `modules/` trong link target Markdown. */
function rewriteUnnamedModuleLinks(line) {
  return line.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    const [pathPart, ...rest] = target.split('#');
    const segments = pathPart.split('/');
    const rewritten = segments.map((s) => (s === UNNAMED_MODULE_DIR ? RENAMED_MODULE_DIR : s));
    if (rewritten.every((s, i) => s === segments[i])) return whole;
    return `](${rewritten.join('/')}${rest.length ? `#${rest.join('#')}` : ''})`;
  });
}

function encodeMdxText(line) {
  let output = '';
  let inlineCodeDelimiter = 0;

  for (let index = 0; index < line.length; ) {
    if (line[index] === '`') {
      let end = index + 1;
      while (line[end] === '`') end++;
      const runLength = end - index;
      if (inlineCodeDelimiter === 0) inlineCodeDelimiter = runLength;
      else if (inlineCodeDelimiter === runLength) inlineCodeDelimiter = 0;
      output += line.slice(index, end);
      index = end;
      continue;
    }

    const character = line[index];
    if (inlineCodeDelimiter === 0) {
      if (character === '{' && line[index - 1] !== '\\') output += '&#123;';
      else if (character === '}' && line[index - 1] !== '\\') output += '&#125;';
      else if (character === '<' && line[index - 1] !== '\\') output += '&lt;';
      else if (character === '>' && line[index - 1] !== '\\') output += '&gt;';
      else output += character;
    } else {
      output += character;
    }
    index++;
  }

  return output;
}

function sanitizeMarkdown(source) {
  let fence;
  return source
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (!fence) fence = marker;
        else if (fence === marker) fence = undefined;
        return line;
      }
      return fence ? line : rewriteUnnamedModuleLinks(encodeMdxText(line));
    })
    .join('\n');
}

/** Đổi tên mọi thư mục `_` (module không tên) thành `modules` trong cây API. */
async function renameUnnamedModuleDirs(directory) {
  let renamed = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    if (entry.name === UNNAMED_MODULE_DIR) {
      const target = join(directory, RENAMED_MODULE_DIR);
      await mkdir(dirname(target), { recursive: true });
      await rename(path, target);
      renamed++;
      continue;
    }
    renamed += await renameUnnamedModuleDirs(path);
  }
  return renamed;
}

const renamedDirs = await renameUnnamedModuleDirs(apiDirectory);

for (const file of await markdownFiles(apiDirectory)) {
  const source = await readFile(file, 'utf8');
  const sanitized = sanitizeMarkdown(source);
  if (sanitized !== source) {
    await writeFile(file, sanitized, 'utf8');
    changedFiles++;
  }
}

console.info(
  `[typedoc-mdx] Renamed ${renamedDirs} unnamed module dir(s) and sanitized ${changedFiles} generated Markdown file(s) under ${relative(
    projectRoot,
    apiDirectory,
  )}.`,
);
