import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatProgress, planProgress, run } from '../tools/plan-progress.mjs';

function capture(files) {
  const lines = { out: [], err: [] };
  const io = {
    read: (path) => {
      if (!(path in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[path];
    },
    out: (text) => lines.out.push(text),
    err: (text) => lines.err.push(text),
  };
  return { io, lines };
}

test('計算完成與未完成的勾選項目', () => {
  assert.deepEqual(planProgress('- [x] 一\n- [ ] 二\n* [X] 三\n'), { done: 2, total: 3, percent: 67, open: ['二'] });
});

test('忽略程式碼區塊內的勾選項目（計畫範本不會干擾統計）', () => {
  assert.equal(planProgress('- [ ] 真的\n```\n- [ ] 範本\n```\n').total, 1);
});

test('沒有勾選項目時給出提示', () => {
  assert.match(formatProgress(planProgress('# 只有標題\n')), /沒有找到/);
});

test('印出進度並回傳 0', () => {
  const { io, lines } = capture({ 'plan.md': '- [x] 一\n- [ ] 二\n' });
  assert.equal(run(['plan.md'], io), 0);
  assert.match(lines.out[0], /^1\/2 完成（50%）/);
});

test('--strict 在未完成時回傳 1、全部完成時回傳 0', () => {
  assert.equal(run(['plan.md', '--strict'], capture({ 'plan.md': '- [ ] 一\n' }).io), 1);
  assert.equal(run(['plan.md', '--strict'], capture({ 'plan.md': '- [x] 一\n' }).io), 0);
});

test('缺少參數或檔案不存在時說明原因並回傳 2', () => {
  const missing = capture({});
  assert.equal(run([], missing.io), 2);
  assert.match(missing.lines.err[0], /用法/);
  assert.equal(run(['nope.md'], missing.io), 2);
  assert.match(missing.lines.err[1], /ENOENT/);
});
