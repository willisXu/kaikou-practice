# 信任等級

目前等級：Level 1

升級靠證據，不靠感覺。每個等級的條件要連續兩週成立，才升到下一級。只有使用者能改這一行。

| 等級 | 你怎麼工作 | agent 做到哪裡 | 升到下一級的條件 |
|---|---|---|---|
| Level 0 觀察 | 一次一個對話，逐步看、隨時糾正；按 Shift+Tab 切回 Manual 模式 | 主 session 直接改碼，每個動作都問你 | 能說出最常糾正的 3 件事，且都已記進 `team/corrections.md` |
| Level 1 委派 | 透過 Chief of Staff 委派，一次一個 worker | 依路由表分工；`node team/tools/verify.mjs` 綠燈才能收工 | 連續 10 個任務一次通過 verifier；出現兩次的修正都已下沉 |
| Level 2 平行 | 一個計畫拆給多個 worker 同時跑；用 `/goal` 盯完成條件 | eng-lead 拆任務、多個 implementer 平行，檔案不重疊 | 連續 2 個多任務計畫沒有返工；架構檢查擋下的問題多於 reviewer 抓到的 |
| Level 3 團隊 | 開啟 agent team；用 `/loop` 跑外層迴圈；auto mode | teammate 共享任務清單、互相傳訊 | 由你決定；每週檢討照常進行 |

各等級的操作方式見 `team/PLAYBOOK.md`。

## 升降紀錄

| 日期 | 變更 | 依據 |
|---|---|---|
| 2026-11-11 | 安裝 agent 團隊，從 Level 1 開始 | 架構檢查、`team/tools/verify.mjs`、審批線已就位 |
