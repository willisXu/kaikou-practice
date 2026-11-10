---
paths:
  - "docs/**"
---

# docs/ 的規則

- 整個 App 在 `docs/index.html` 一個檔案：不拆檔、不加建置步驟、不引入框架。
- 這個檔案同時給 GitHub Pages 和 Claude Artifact 用。只給 GitHub Pages 用的標籤要標 `data-pages-only`，`tools/artifact.js` 會拿掉它們。
- 資料怎麼寫入、怎麼同步、讀不到時怎麼辦，都記在 `README.md` 的「程式重點」。改到這些行為之前先讀，改完同步更新 README。
- 教練（`sample()`）只在使用者按下按鈕時呼叫；打開頁面、重新讀取都不能自己呼叫。
- 看起來像 HTML 的文字一律當成文字處理。
- 每日一課的 `COURSE` 的 `k` 不能換：存著的進度靠它對上。
- 程式要讓舊版 Safari 讀得懂；改了 `sw.js` 或 manifest，跑 `npm test -- 8`。
