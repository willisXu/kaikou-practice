#!/usr/bin/env node
// 唯一的驗證入口：agent 收工前、CI、你自己都跑這一個。
// 用法：node team/tools/verify.mjs [--if-changed]
// --if-changed：這個版本（commit 加上未提交的改動）已經驗證通過時，直接放行不重跑。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardrailTests = readdirSync(join(root, 'team/guardrails'))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => `team/guardrails/${name}`);

// 這個專案的檢查，依序執行，一步失敗就停。
const steps = [
  { name: '架構檢查', command: process.execPath, args: ['team/tools/check-architecture.mjs'] },
  { name: '護欄測試', command: process.execPath, args: ['--test', '--test-reporter=spec', ...guardrailTests] },
  {
    name: '瀏覽器測試：實際打開 docs/index.html 跑完整流程（Playwright，約 5 分鐘）',
    command: process.execPath,
    args: ['test/run.js'],
    needs: () =>
      spawnSync(process.execPath, ['-e', "require.resolve('playwright')"], { cwd: root }).status === 0 ||
      '找不到 Playwright。先執行：npm install && npx playwright install chromium',
  },
  {
    name: '發布腳本測試',
    command: 'bash',
    args: ['test/publish.sh'],
    skip: () => process.platform === 'win32' && 'Windows 上略過（需要 bash）',
  },
];

function fingerprint() {
  const git = (args) => spawnSync('git', args, { cwd: root, maxBuffer: 512 * 1024 * 1024 });
  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0) return null;
  const hash = createHash('sha256').update(head.stdout).update(git(['diff', 'HEAD', '--binary']).stdout);
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).stdout.toString();
  for (const file of untracked.split('\0').filter(Boolean)) {
    hash.update(file);
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      hash.update('unreadable');
    }
  }
  return hash.digest('hex');
}

const stampFile = join(tmpdir(), `team-verify-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`);
const before = fingerprint();

if (process.argv.includes('--if-changed') && before && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === before) {
  console.log('✓ 這個版本已經驗證通過，之後沒有新改動，略過重跑。');
  process.exit(0);
}

const started = Date.now();
for (const step of steps) {
  const skipped = step.skip?.();
  if (skipped) {
    console.log(`\n– ${step.name}：${skipped}`);
    continue;
  }
  const missing = step.needs?.();
  if (missing && missing !== true) {
    console.error(`\n✗ ${step.name}：${missing}`);
    process.exit(1);
  }
  console.log(`\n▶ ${step.name}`);
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`\n✗ ${step.name}失敗。修好再收工；不要改測試、規則或 hooks 來讓它通過。`);
    process.exit(result.status ?? 1);
  }
}

if (before && fingerprint() === before) writeFileSync(stampFile, before);
console.log(`\n✓ 全部通過（${((Date.now() - started) / 1000).toFixed(1)} 秒）`);
