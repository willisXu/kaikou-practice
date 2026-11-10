# 操作手冊

## 第一次啟動

見 `team/README.md` 的「開始」。進入 Claude Code 後：

1. 信任這個資料夾（專案的 hooks 與 agents 要信任後才會生效）。
2. 輸入 `/agents`，確認看到 6 個 agent：eng-lead、implementer、verifier、reviewer、investigator、guardrail-engineer。
3. 輸入 `/hooks`，確認 SessionStart、PreToolUse、TaskCompleted 都已載入。

## 日常指令

| 你想做的事 | 輸入 |
|---|---|
| 開一個新工作 | `/kickoff <需求>` |
| 驗證某項改動真的可用 | `/prove-it [任務或功能]` |
| 糾正 agent，並避免再犯 | `/codify <修正內容>` |
| 每週檢討 | `/weekly-review` |
| 指定某個 agent 做事 | `@agent-investigator 為什麼這個測試失敗？` |
| 看計畫進度 | `node team/tools/plan-progress.mjs team/plans/<檔名>.md` |
| 全部驗證 | `node team/tools/verify.mjs` |

## 各等級怎麼用

目前等級寫在 `team/TRUST.md` 開頭，升級條件也在那裡。

### Level 1 委派

用 `/kickoff` 開工，看 eng-lead 拆出的計畫，逐個任務看 verifier 的判定。每次糾正都用 `/codify` 記帳。這個階段的目標是找出你最常糾正的事，並把它們下沉成規則。

### Level 2 平行

eng-lead 會把無相依、檔案不重疊的任務同時分派。按 Shift+Tab 切到 auto mode，再用 `/goal` 盯完成條件：

```
/goal node team/tools/plan-progress.mjs team/plans/<檔名>.md --strict 結束碼為 0，且 node team/tools/verify.mjs 通過；不得修改 team/architecture.rules.json 與既有測試的斷言；30 回合內未完成就停下回報卡點
```

`/goal` 每回合結束後由另一個模型判斷條件是否成立，所以條件要寫成對話中看得到證據的形式。

### Level 3 團隊

1. 在 `.claude/settings.local.json`（不進版控）開啟 agent team：

   ```json
   {
     "env": {
       "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
     }
   }
   ```

2. 用 subagent 定義開 teammate：

   ```
   開一個 agent team 執行 team/plans/<檔名>.md：
   - T1、T2、T3 各開一個 teammate，使用 implementer agent type，分別命名 t1、t2、t3；每個只能改自己任務的擁有檔案
   - 再開一個 teammate，使用 verifier agent type，命名 qa，負責驗證每個完成的任務
   - lead 不要自己實作，等所有 teammate 完成再整合
   ```

   teammate 不會套用 agent 檔案裡的 hooks，所以「verify 不綠不准完成」改由 `.claude/settings.json` 的 TaskCompleted hook 把關。

3. 用 `/loop` 跑外層迴圈：`/loop 30m` 會照 `.claude/loop.md` 每 30 分鐘巡視一次。`/loop` 只在 session 開著時運作，七天後自動到期；要長期排程，改用 Claude 桌面版的排程任務。

agent team 仍是實驗功能，會用掉明顯更多的 token。建議從 3 個 teammate 開始。

## 每週檢討

每週跑一次 `/weekly-review`，約 15 分鐘。也可以在 Claude 桌面版設一個每週的排程任務來跑它。重點是第 5 題：找出一個最沒用的東西刪掉。

## 驗證很慢的時候

`node team/tools/verify.mjs --if-changed` 會記住最後一次通過的版本：commit 與未提交的改動都沒變時直接放行。implementer 收工時的 hook 就是這樣用，所以 agent 自己跑過一次綠燈後，hook 不會再重跑一次。
