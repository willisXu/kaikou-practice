# agent 團隊

依 Lauren Tan（Grok Bot 首席工程師）的方法論打造的 Claude Code 開發團隊。核心主張：產出量來自信任，不是來自開更多 agent。所以先打地基，讓錯的寫法走不通，再逐級放大平行。

## 團隊

| 角色 | 在哪裡 | 做什麼 | 不做什麼 |
|---|---|---|---|
| 你 | — | 給目標、核准不可逆的事、決定信任等級 | — |
| Chief of Staff | 主 session（`CLAUDE.md`） | 整理需求、依路由表委派、收斂回報、記修正 | 不直接改產品程式 |
| eng-lead | `.claude/agents/eng-lead.md` | 拆計畫、分派、收斂 | 只能寫 `team/plans/`（hook 強制） |
| implementer | `.claude/agents/implementer.md` | 做單一任務 | verify 不綠不能收工（hook 強制） |
| verifier | `.claude/agents/verifier.md` | 獨立驗證、留下證據 | 不改檔案 |
| reviewer | `.claude/agents/reviewer.md` | 審 diff，標出每個問題該由哪層攔住 | 只能寫自己的記憶 |
| investigator | `.claude/agents/investigator.md` | 重現、比較假設、找根因 | 不改程式碼 |
| guardrail-engineer | `.claude/agents/guardrail-engineer.md` | 把重複的修正下沉成規則、檢查、測試 | 只能改 `team/` 與 `.claude/` 的指引（hook 強制） |

## 方法論對照

| 她的做法 | 在這個專案 |
|---|---|
| 先建立信任，再談平行 | `team/TRUST.md`：Level 0 到 3，附升級條件 |
| 五層修正機制 | `team/corrections.md` 帳本、`/codify`、guardrail-engineer |
| 讓捷徑就是正路 | `team/architecture.rules.json` 與 `team/tools/check-architecture.mjs` |
| 程式碼庫就是 agent 的記憶 | 禁用權宜註解、每種事只有一條正路、agent 專屬記憶 |
| 讓 agent 自己驗證 | `team/feature-map.md`、Playwright 瀏覽器測試、verifier、`/prove-it` |
| 以可逆性畫審批線 | `.claude/settings.json` 權限與 `.claude/hooks/guard-irreversible.mjs` |
| 外層迴圈、`/loop`、`/goal` | `.claude/loop.md`、`team/PLAYBOOK.md` 的範本 |
| 每週檢討、果斷刪減 | `/weekly-review` |
| Skills 也要測試 | `team/evals.md` |

## 開始

```bash
git pull
npm install && npx playwright install chromium
node team/tools/verify.mjs
claude
```

`verify` 完整跑一次約 5 分鐘（大部分是瀏覽器測試）。進入 Claude Code 後輸入 `/kickoff <你的需求>`。完整操作見 `team/PLAYBOOK.md`。需要 Node.js 20 以上。

## 結構

```
CLAUDE.md                     專案重點、Chief of Staff 的角色、路由表、審批線
team/TRUST.md                 信任等級與升級條件
team/corrections.md           修正帳本
team/feature-map.md           每個功能怎麼觸發、怎麼驗證
team/conventions.md           還無法自動檢查的慣例
team/plans/                   eng-lead 寫的計畫
team/architecture.rules.json  分層邊界與禁用寫法
team/tools/                   verify（唯一驗證入口）、架構檢查、計畫進度
team/guardrails/              證明護欄有效的測試
team/evals.md                 skill 與 agent 的行為情境
.claude/agents/               6 個 agent
.claude/skills/               /kickoff、/prove-it、/codify、/weekly-review
.claude/hooks/                審批線、寫入範圍、verify 閘門、開工簡報
.claude/rules/                依路徑載入的指引
.claude/loop.md               /loop 的巡視內容
.github/workflows/team-verify.yml  CI：每次推送與 PR 跑 verify
```

## 拿掉團隊

刪除 `team/`、`.claude/`（保留你自己的 `settings.local.json`）、`CLAUDE.md` 與 `.github/workflows/team-verify.yml`，並把 `.gitignore` 的 `.claude/` 段落改回 `.claude/`。產品程式沒有任何部分依賴這些檔案。
