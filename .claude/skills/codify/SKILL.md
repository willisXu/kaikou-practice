---
name: codify
description: 把一個修正記進帳本，並在第二次出現時下沉到最強的可行層（架構、靜態檢查、指引、慣例、驗證）。使用者糾正同一件事、reviewer 建議 codify，或使用者說「記起來」「以後不要再這樣」時使用。
argument-hint: <修正內容>
---

# Codify

修正：$ARGUMENTS

帳本中待處理的項目：

```!
grep '待處理' team/corrections.md || echo '（無）'
```

1. 在 `team/corrections.md` 找這筆修正。找不到就新增一列：日期、內容、出現次數 1、你判斷應下沉到的層、狀態「待處理」。找到就把出現次數加 1。
2. 出現次數只有 1，且使用者沒有要求立刻處理：告訴使用者「已記帳，再出現一次就下沉」，到此為止。
3. 出現次數達 2，或使用者要求立刻處理：交給 `guardrail-engineer`（Agent 工具），prompt 附上這筆修正、相關檔案，以及使用者原話。
4. 回報使用者：選了哪一層、改了哪些檔、怎麼證明有效，以及需要使用者核准的變更（`team/architecture.rules.json`、`.claude/settings.json`、hooks 都會跳出核准提示）。
