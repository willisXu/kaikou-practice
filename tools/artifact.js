// 把 docs/index.html（完整的 HTML 文件，給 GitHub Pages 與直接開檔用）轉成 Claude Artifact 要的頁面片段。
// Claude 發佈時會自己包上 <!doctype>、<html>、<head>（含 charset 與 viewport）和 <body>，
// 所以這裡拿掉這些外層標籤，其餘內容原樣保留，<title> 會在最前面。
// 只給 GitHub Pages 用的標籤（加到主畫面的 manifest、圖示、theme-color，標了 data-pages-only）也一起拿掉。
// 用法：node tools/artifact.js <輸出檔>     （沒給輸出檔就印到螢幕）
'use strict';
const fs = require('fs');
const path = require('path');

function toArtifact(html) {
  const out = String(html)
    .replace(/^﻿/, '')
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html\b[^>]*>\s*/i, '')
    .replace(/<head>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '')
    .replace(/<(?:link|meta)\b[^>]*\bdata-pages-only\b[^>]*>\s*/gi, '')
    .replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '')
    .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
  if (!/^<title>/.test(out)) throw new Error('tools/artifact.js: docs/index.html 的 <head> 結構和預期不同，請檢查開頭');
  if (/<\/?(html|head|body)\b|<!doctype/i.test(out)) throw new Error('tools/artifact.js: 還留有 html/head/body 標籤');
  if (/data-pages-only|rel="manifest"/i.test(out)) throw new Error('tools/artifact.js: 還留有只給 GitHub Pages 用的標籤');
  return out;
}

module.exports = { toArtifact };

if (require.main === module) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'index.html'), 'utf8');
  const out = toArtifact(src);
  if (process.argv[2]) { fs.writeFileSync(process.argv[2], out); console.log('已寫入 ' + process.argv[2]); }
  else process.stdout.write(out);
}
