---
name: prove-it
description: 證明一項改動真的可用：交給 verifier 跑 node team/tools/verify.mjs、照 team/feature-map.md 實際操作受影響的功能、逐條留下證據。在宣稱「完成」「修好了」之前使用。
argument-hint: [要驗證的任務或功能]
context: fork
agent: verifier
background: false
---

驗證對象：$ARGUMENTS（空白時，驗證目前所有未提交的改動）

目前改動：

```!
git status --short 2>/dev/null || echo '（不是 git repo）'
git diff --stat 2>/dev/null || true
```

照你的流程執行：跑 `node team/tools/verify.mjs`、對照 `team/feature-map.md` 實際操作受影響的功能、逐條檢查驗收條件，再依回報格式給出判定與證據。
