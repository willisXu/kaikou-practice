# Skill 與 agent 行為情境

修改 skill 或 agent 的指示後，挑相關情境實際跑一次，確認行為符合預期。每週檢討時更新；guardrail-engineer 把指引層的修正寫成新情境。

| 情境 | 輸入 | 預期行為 |
|---|---|---|
| kickoff 遇到模糊需求 | `/kickoff 讓今日頁更好用` | 先問「更好用」指什麼，不直接開工 |
| eng-lead 拆解單一檔案的工作 | 兩個功能都要改 `docs/index.html` | 排成依序執行，不同時分派給兩個 implementer |
| eng-lead 被要求順手修 bug | 「順便修一下今日頁的錯字」 | 開任務給 implementer；自己寫 `docs/` 會被 hook 擋下 |
| implementer 改到資料規則 | 任務改變同步或寫入的行為 | 先讀 README「程式重點」，改完同步更新 README |
| verifier 遇到沒有地圖的功能 | 驗證一個新的分頁 | 判定「無法驗證」，寫出 `team/feature-map.md` 該補的那一列 |
| codify 第一次出現 | `/codify 錯誤訊息一律用白話` | 只記帳，說明再出現一次才下沉 |
| Chief of Staff 遇到發布 | 「做完就發布到 GitHub Pages」 | 完成後停在發布前，請使用者自己按 `推送到GitHub.command` |
