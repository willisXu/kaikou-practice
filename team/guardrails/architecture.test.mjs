import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { findViolations } from '../tools/check-architecture.mjs';

// 拆開寫，免得這個測試檔自己被禁用寫法規則擋下。
const marker = ['HA', 'CK'].join('');
const fakeKey = ['sk', 'ant', 'api03', 'x'.repeat(40)].join('-');

const rules = {
  scan: ['.'],
  boundaries: [
    { files: 'src/core/', mustNotImport: ['src/app/', 'node:fs'], why: 'core 要純粹' },
    { files: ['analysis.py'], mustNotImport: ['os', 'urllib'], why: '計算模組不碰外部' },
  ],
  bannedPatterns: [
    { pattern: `\\b${marker}\\b`, why: '不要找藉口' },
    { pattern: 'sk-ant-(api|admin|oat)\\d{2}-[A-Za-z0-9_-]{20,}', why: '金鑰不進版控' },
    { pattern: '\\b(test|it)\\.only\\(', files: 'test/', why: '不要只跑一個測試' },
  ],
};

const root = mkdtempSync(join(tmpdir(), 'arch-guardrail-'));
after(() => rmSync(root, { recursive: true, force: true }));

function project(files) {
  const dir = mkdtempSync(join(root, 'case-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const violations = (files) => findViolations(project(files), rules).violations;

test('擋下 core 依賴 app 層', () => {
  assert.equal(violations({ 'src/core/a.mjs': "import { x } from '../app/x.mjs';\n", 'src/app/x.mjs': '' }).length, 1);
});

test('擋下 core 讀檔，不論寫成 fs、node:fs 或 fs/promises', () => {
  assert.equal(violations({ 'src/core/a.mjs': "import a from 'node:fs';\nimport b from 'fs/promises';\n" }).length, 2);
});

test('擋下 Python 計算模組 import 外部模組，包含子模組與逗號清單', () => {
  const found = violations({ 'analysis.py': 'import math, os\nfrom urllib.request import urlopen\n' });
  assert.equal(found.length, 2);
});

test('放行 Python 的相對 import 與不在清單上的模組', () => {
  assert.deepEqual(violations({ 'analysis.py': 'import math\nfrom . import helpers\n' }), []);
});

test('擋下替權宜寫法找藉口的註解', () => {
  assert.match(violations({ 'src/app/a.mjs': `// ${marker}: 先這樣\n` })[0], /禁用寫法/);
});

test('擋下寫死在程式裡的 API 金鑰', () => {
  assert.equal(violations({ 'config.py': `KEY = "${fakeKey}"\n` }).length, 1);
});

test('只在指定的路徑套用禁用寫法', () => {
  const only = ['test', 'only('].join('.');
  assert.equal(violations({ 'test/a.js': `${only}'x', () => {});\n`, 'src/b.js': `${only}'y', () => {});\n` }).length, 1);
});

test('略過 node_modules 與 .venv', () => {
  assert.deepEqual(violations({ 'node_modules/x/a.js': `// ${marker}\n`, '.venv/lib/b.py': `# ${marker}\n` }), []);
});

test('放行 app 依賴 core 與 node:fs', () => {
  const found = violations({
    'src/app/a.mjs': "import { y } from '../core/y.mjs';\nimport fs from 'node:fs';\n",
    'src/core/y.mjs': 'export const y = 1;\n',
  });
  assert.deepEqual(found, []);
});
