---
name: kickoff
description: 開一個新工作：把需求整理成一句目標與可驗證的驗收條件，交給 eng-lead 拆成計畫並分派。用在新功能、跨多檔改動，或使用者說「開工」「幫我做某某功能」時。
argument-hint: <需求描述>
---

# Kickoff

需求：$ARGUMENTS

目前信任等級：!`grep -m1 '目前等級' team/TRUST.md || echo '未設定'`

既有計畫：!`ls team/plans/ 2>/dev/null | grep -v README || echo '（無）'`

## 1. 整理需求（Chief of Staff 自己做）

- 用一句話寫目標：完成後使用者能做到什麼。
- 列出 3 到 7 條驗收條件，每條都寫明怎麼證明（哪個指令、看到什麼輸出）。
- 列出不做的範圍。
- 有會影響做法的模糊處，先問使用者，得到答案再往下。

## 2. 交給 eng-lead

用 Agent 工具（subagent_type: `eng-lead`）。prompt 包含目標、驗收條件、不做的範圍、使用者提到的限制，以及目前信任等級。

## 3. 收斂回報

eng-lead 回報後，給使用者：

- 計畫檔路徑，以及 `node team/tools/plan-progress.mjs <計畫檔>` 的輸出
- 每個任務的驗證判定與關鍵證據
- 需要使用者決定的事（推送、合併、新增套件、規則變更）

## 4. 讓它自己跑到完成（Level 2 以上）

建議使用者在 auto mode 下輸入：

```
/goal node team/tools/plan-progress.mjs <計畫檔> --strict 結束碼為 0，且 node team/tools/verify.mjs 通過；不得修改 team/architecture.rules.json 與既有測試的斷言；30 回合內未完成就停下回報卡點
```
