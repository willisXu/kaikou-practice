# 修正帳本

使用者每糾正一次，記一筆（用 `/codify`）。同一類出現第二次，交給 `guardrail-engineer` 下沉。只在聊天裡糾正，下個 session 就忘了。

應下沉到的層，由強到弱：

1. 架構：讓錯的寫法寫不出來（`team/architecture.rules.json` 的邊界）
2. 靜態檢查：禁用寫法、檢查腳本、測試、CI
3. 指引：`CLAUDE.md`、`.claude/rules/`、skills、agent 指示
4. 慣例與人工審查：`team/conventions.md`
5. 驗證：`team/feature-map.md`、`/prove-it`

狀態只用兩種：待處理、已下沉（註明改了哪些檔案）。

| 日期 | 修正內容 | 出現次數 | 應下沉到 | 狀態 |
|---|---|---|---|---|
