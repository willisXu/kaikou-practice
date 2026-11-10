#!/usr/bin/env node
// PreToolUse（Edit|Write）：限制角色只能寫入指定路徑。用法：node write-scope.mjs <路徑或目錄/>...
// 例：eng-lead 只能寫 team/plans/，因為它負責拆解，不寫程式碼。
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { decide, readHookInput } from './read-stdin.mjs';

const allowed = process.argv.slice(2);
const input = await readHookInput();
const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
if (!filePath) process.exit(0);

const roots = [process.env.CLAUDE_PROJECT_DIR, input.cwd].filter(Boolean);
const absolute = isAbsolute(filePath) ? filePath : resolve(input.cwd ?? process.cwd(), filePath);

const inScope = roots.some((root) => {
  const rel = relative(root, absolute).split(sep).join('/');
  if (rel.startsWith('..')) return false;
  return allowed.some((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix));
});

if (!inScope) {
  decide(
    'deny',
    `這個角色只能寫入：${allowed.join('、')}。${filePath} 不在範圍內。請在回報中寫出需要的改動，交給負責的角色。`,
  );
}
