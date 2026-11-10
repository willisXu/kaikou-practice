#!/usr/bin/env node
// 計畫進度：數計畫檔裡的勾選項目（程式碼區塊內的不算）。
// 用法：node team/tools/plan-progress.mjs <計畫檔.md> [--strict]
// --strict：還有沒完成的項目（或一項都沒有）時，結束碼為 1，給 /goal 當完成條件。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKBOX = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const USAGE = '用法：node team/tools/plan-progress.mjs <計畫檔.md> [--strict]';

export function planProgress(markdown) {
  const items = [];
  let inFence = false;

  for (const line of markdown.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(CHECKBOX);
    if (match) items.push({ done: match[1] !== ' ', text: match[2].trim() });
  }

  const done = items.filter((item) => item.done).length;
  const total = items.length;
  return {
    done,
    total,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
    open: items.filter((item) => !item.done).map((item) => item.text),
  };
}

export function formatProgress({ done, total, percent, open }) {
  if (total === 0) return '沒有找到任何勾選項目（- [ ] 或 - [x]）。';
  const head = `${done}/${total} 完成（${percent}%）`;
  if (open.length === 0) return head;
  return [head, '未完成：', ...open.map((text) => `  - ${text}`)].join('\n');
}

export function run(argv, io = {}) {
  const read = io.read ?? ((path) => readFileSync(path, 'utf8'));
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  const [file, ...flags] = argv;

  if (!file || file.startsWith('-')) {
    err(USAGE);
    return 2;
  }

  let markdown;
  try {
    markdown = read(file);
  } catch (error) {
    err(`讀不到檔案：${file}（${error.code ?? error.message}）`);
    return 2;
  }

  const result = planProgress(markdown);
  out(formatProgress(result));
  const incomplete = result.total === 0 || result.done < result.total;
  return flags.includes('--strict') && incomplete ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
