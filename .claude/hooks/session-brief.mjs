#!/usr/bin/env node
// SessionStart：開工簡報。把信任等級、待下沉的修正、進行中的計畫放進 Chief of Staff 的脈絡。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const read = (path) => {
  try {
    return readFileSync(join(root, path), 'utf8');
  } catch {
    return '';
  }
};

function countChecks(markdown) {
  let inFence = false;
  let done = 0;
  let total = 0;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    else if (!inFence) {
      const match = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s/);
      if (match) {
        total += 1;
        if (match[1] !== ' ') done += 1;
      }
    }
  }
  return { done, total };
}

const level = read('team/TRUST.md').match(/目前等級：\s*(Level\s*\d)/)?.[1] ?? '未設定';

const pending = read('team/corrections.md')
  .split('\n')
  .filter((line) => line.startsWith('|') && line.includes('待處理'));
const repeated = pending.filter((line) => Number(line.split('|')[3]?.trim()) >= 2);

let plans = [];
try {
  plans = readdirSync(join(root, 'team/plans'))
    .filter((name) => name.endsWith('.md') && name !== 'README.md')
    .map((name) => ({ name, ...countChecks(read(`team/plans/${name}`)) }))
    .filter((plan) => plan.total > 0 && plan.done < plan.total);
} catch {
  plans = [];
}

const lines = [
  `[agent 團隊開工簡報] 信任等級：${level}（team/TRUST.md）`,
  `待處理的修正：${pending.length} 筆${repeated.length ? `，其中 ${repeated.length} 筆已出現 2 次以上，應交給 guardrail-engineer` : ''}。`,
  plans.length
    ? `進行中的計畫：${plans.map((plan) => `team/plans/${plan.name}（${plan.done}/${plan.total}）`).join('、')}`
    : '沒有進行中的計畫。',
];
console.log(lines.join('\n'));
