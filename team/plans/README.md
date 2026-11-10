# 計畫格式

每個計畫一個檔案：`team/plans/YYYY-MM-DD-<主題>.md`。由 eng-lead 撰寫，Chief of Staff 用 `node team/tools/plan-progress.mjs <檔案>` 追進度。程式碼區塊內的勾選項目不計入進度，所以下面的範本不會干擾統計。

````markdown
# <主題>

## 目標
一句話：完成後使用者能做到什麼。

## 不做
- 明確排除的範圍

## 任務
擁有檔案不可重疊，才能平行。

### T1 <任務名稱>
- 負責：implementer
- 擁有檔案：`src/...`、`test/...`
- 相依：無
- 驗收：
  - [ ] 具體、可驗證的條件（附證明方式）
  - [ ] `node team/tools/verify.mjs` 通過

### T2 <任務名稱>
- 負責：implementer
- 擁有檔案：`src/...`
- 相依：T1
- 驗收：
  - [ ] ...
  - [ ] `node team/tools/verify.mjs` 通過

## 整體驗收
- [ ] verifier 照 `team/feature-map.md` 走過受影響的功能
- [ ] reviewer 沒有阻擋性意見
````
