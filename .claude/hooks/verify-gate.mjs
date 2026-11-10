#!/usr/bin/env node
// Stop（implementer）與 TaskCompleted（agent team）：team/tools/verify.mjs 不綠，不准收工。
// 這個版本已經驗證通過、之後沒有新改動時，verify.mjs --if-changed 直接放行，不重跑。
// 最多擋 3 次，避免卡死；第 4 次放行，但回報必須寫明失敗項目。
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHookInput } from './read-stdin.mjs';

const MAX_BLOCKS = 3;
const input = await readHookInput();

if (input.hook_event_name === 'TaskCompleted' && !input.teammate_name) process.exit(0);

const root = [input.cwd, process.env.CLAUDE_PROJECT_DIR].find(
  (dir) => dir && existsSync(join(dir, 'team/tools/verify.mjs')),
);
if (!root) process.exit(0);

const key = String(input.task_id ?? input.agent_id ?? input.session_id ?? 'session').replace(/[^\w-]/g, '_');
const stateFile = join(tmpdir(), `agent-kitchen-verify-gate-${key}`);
const blocks = existsSync(stateFile) ? Number(readFileSync(stateFile, 'utf8')) || 0 : 0;

const result = spawnSync(process.execPath, ['team/tools/verify.mjs', '--if-changed'], { cwd: root, encoding: 'utf8' });
if (result.status === 0) {
  rmSync(stateFile, { force: true });
  process.exit(0);
}

if (blocks >= MAX_BLOCKS) {
  rmSync(stateFile, { force: true });
  process.exit(0);
}

writeFileSync(stateFile, String(blocks + 1));
const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
console.error(
  [
    `team/tools/verify.mjs 沒有通過（第 ${blocks + 1}/${MAX_BLOCKS} 次攔下），還不能收工。`,
    '修好失敗的項目再回報；不要修改測試、team/architecture.rules.json 或 hooks 來讓它通過。',
    `若第 ${MAX_BLOCKS} 次仍修不好，在回報中寫明失敗項目與卡住的原因。`,
    '',
    tail,
  ].join('\n'),
);
process.exit(2);
