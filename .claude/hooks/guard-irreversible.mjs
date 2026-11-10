#!/usr/bin/env node
// PreToolUse（Bash）：審批線。一分鐘內無法復原的指令，擋下或交給使用者決定。
// settings.json 的規則擋得住常見寫法；這裡補上規則比對不到的變形（git -C . push、cd x && git push 等）。
import { decide, readHookInput } from './read-stdin.mjs';

const DENY = [
  [/\bgit\b[^;&|]*\bpush\b[^;&|]*(\s--force(?!-with-lease)\b|\s-f\b|\s\+\S)/, '強制推送會覆蓋遠端歷史，無法復原。'],
  [/\bgit\b[^;&|]*\breset\b[^;&|]*--hard\b/, 'git reset --hard 會丟掉尚未提交的工作。'],
  [/\bgit\b[^;&|]*\bclean\b[^;&|]*\s-[a-zA-Z]*f/, 'git clean -f 會永久刪除未追蹤的檔案。'],
  [/\brm\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME)\/?(\s|$)/, '刪除根目錄或家目錄。'],
  [/\bsudo\b/, '不使用系統管理員權限。'],
];

const ASK = [
  [/\bgit\b[^;&|]*\bpush\b/, '推送到遠端，別人會看到。'],
  [/\bgh\s+(pr\s+(create|merge|close)|release|repo\s+(create|delete|edit))\b/, '開、合或關閉 PR、發佈版本，都是對外動作。'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b/, '發佈套件後無法收回。'],
  [/\b(npm|pnpm|yarn|bun)\s+(install|i|add)\s+\S/, '新增相依套件需要你同意。'],
  [/\brm\s+-[a-zA-Z]*[rf]/, '遞迴或強制刪除檔案。'],
  [/\bgit\b[^;&|]*\bbranch\b[^;&|]*\s-D\b/, '強制刪除分支。'],
  [/\bgit\b[^;&|]*\btag\b[^;&|]*\s-d\b/, '刪除標籤。'],
  [/\bcurl\b[^;&|]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--data\b|\s-d\s|\s-F\s|\s--form\b)/i, '對外送出資料。'],
  [/\b(ssh|scp|rsync)\s/, '連到其他機器。'],
  [/\bdocker\b[^;&|]*\bdown\b[^;&|]*\s-v\b|\bdocker\s+volume\s+(rm|prune)\b/, '刪除 Docker volume 會丟掉裡面的資料。'],
  [/\bdocker\b[^;&|]*\b(push|system\s+prune)\b/, '推送映像或清除 Docker 資料。'],
  [/\b(gcloud|aws)\s|(^|[;&|]\s*)(\.\/)?deploy\/\S|\b(bash|sh|zsh)\s+(\.\/)?deploy\//, '部署或操作雲端資源，可能產生費用。'],
  [/推送到GitHub/, '這個腳本會發布到 GitHub。'],
];

const input = await readHookInput();
const command = input.tool_input?.command ?? '';

const denied = DENY.find(([pattern]) => pattern.test(command));
if (denied) {
  decide('deny', `${denied[1]}這條線由 .claude/hooks/guard-irreversible.mjs 強制，需要時請使用者自己執行。`);
  process.exit(0);
}

const asked = ASK.find(([pattern]) => pattern.test(command));
if (asked) decide('ask', `${asked[1]}依審批線，這一步要你核准。`);
