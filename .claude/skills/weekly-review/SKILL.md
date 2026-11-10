---
name: weekly-review
description: 每週 15 分鐘檢討：計畫進度、修正帳本、agent 與 skill 的表現、該刪減什麼、信任等級要不要調整。使用者說「週檢討」「weekly review」時使用。
disable-model-invocation: true
---

# 每週檢討

近 7 天的提交：

```!
git log --since="7 days ago" --oneline 2>/dev/null | head -50 || true
```

計畫進度：

```!
for f in team/plans/*.md; do
  [ "$(basename "$f")" = README.md ] && continue
  [ -f "$f" ] && echo "$f：$(node team/tools/plan-progress.mjs "$f" | head -1)"
done
true
```

修正帳本：

```!
cat team/corrections.md 2>/dev/null || true
```

信任等級：

```!
cat team/TRUST.md 2>/dev/null || true
```

逐項回答，每項一到三行：

1. 計畫：哪些完成、哪些卡住、卡住的原因。
2. 修正帳本：本週新增幾筆、下沉幾筆；哪些已出現兩次以上卻還沒下沉。
3. Agent：依本週的計畫、驗證結果與帳本，哪個 agent 最常返工或被糾正、被糾正什麼。讀 `.claude/agent-memory/*/MEMORY.md`，指出過時或互相矛盾的內容。
4. Skill：哪個 skill 被略過或誤用？`team/evals.md` 的情境還符合現況嗎？提出具體修改。
5. 刪減：哪個 agent、skill、規則或例行任務最沒用？如果刪掉，使用者會想念嗎？只推薦一個刪除對象。
6. 信任等級：對照 `team/TRUST.md` 的升級條件，建議維持、升級或降級，並附依據。

最後親手抽查：從本週驗證過的任務中挑一個，重跑 `node team/tools/verify.mjs`，照 `team/feature-map.md` 實際操作一次。agent 檢討自己的工作，盲點和你一樣。

不要直接修改檔案，把建議列給使用者決定。
