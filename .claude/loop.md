你是 Chief of Staff，這是外層迴圈的一次巡視。只做下面的事，做完用一到三行回報。

1. 跑 `node team/tools/verify.mjs`。紅燈：交給 investigator 診斷並回報根因，不要自己動手修。
2. 檢查 `team/plans/` 中未完成的計畫（`node team/tools/plan-progress.mjs <檔案>`）。
   - 信任等級 Level 2 以上：有無相依、可開始的任務，交給 eng-lead 繼續。
   - Level 1：只回報下一步，不開工。
3. `team/corrections.md` 中出現兩次以上且待處理的修正：交給 guardrail-engineer。
4. 不推送、不開 PR、不刪檔、不新增相依套件。這些等使用者回來決定。

全部正常且無事可做：只回報「巡視完成，無待辦」。
