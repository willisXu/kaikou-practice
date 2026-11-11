#!/bin/bash
# 開口練習室：把這個資料夾的變更發布到公開的 GitHub repo willisXu/kaikou-practice（Mac 版，點兩下就會在「終端機」裡執行）。
# 和 推送到GitHub.bat（Windows 版）做一樣的事：
# - 只發布 repo 裡原有的檔案、docs/、test/、tools/ 裡新的網頁、程式與圖示，和教練伺服器新的程式、package.json 與
#   render.yaml（依副檔名）；其他新檔案（例如匯出的備份檔、4/3/2 的錄音、合併工具留下的檔案、放金鑰的 server/.env）
#   可能有私人的內容，只留在這台電腦。
# - 只從 main 分支發布；要發布的版本少了網站的檔案、或 docs/index.html 不完整時不推送。
# - 這台電腦上用別的方式做的、還沒上 GitHub 的 commit，會先列出來，按 Y 才一起發布。
# - 推送成功後，GitHub Pages 約 1 分鐘後更新。
# 只用 macOS 內建的 bash 3.2 就有的功能。

cd "$(dirname "$0")" || exit 1
export GIT_PAGER=cat PAGER=cat # 列出很多檔案時不要停在分頁程式（less）等人按 q
COMMITTED=0
OURTIME=

finish() {
  echo
  read -r -p "按 Enter 關閉這個視窗…" _
  exit "${1:-0}"
}

failed() {
  echo
  echo "沒有成功，請看上面的訊息。這次沒有發布任何新的東西。"
  finish 1
}

# ask "問題"：輸入 Y 再按 Enter 回傳 0、輸入 N 再按 Enter 回傳 1（讀不到輸入時當作 N）。
# 讀一整行：只讀一個鍵的話，多按的 Enter 會被下一個問題（例如名字）當成空白的回答。
ask() {
  local a
  while true; do
    read -r -p "$1 (輸入 Y 或 N，再按 Enter) " a || [ -n "$a" ] || { echo; return 1; }
    case "$a" in
      [Yy]*) return 0 ;;
      [Nn]*) return 1 ;;
    esac
  done
}

rebasing() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]
}

# 還沒完成的合併類動作（rebase、merge、cherry-pick、revert）：印出取消它的指令；沒有就不印。
unfinished() {
  if rebasing; then echo "git rebase --abort"
  elif [ -e "$(git rev-parse --git-path MERGE_HEAD)" ]; then echo "git merge --abort"
  elif [ -e "$(git rev-parse --git-path CHERRY_PICK_HEAD)" ]; then echo "git cherry-pick --abort"
  elif [ -e "$(git rev-parse --git-path REVERT_HEAD)" ]; then echo "git revert --abort"
  fi
}

# 檔案裡留著衝突標記（<<<<<<<、=======、>>>>>>> 這類的行）：發布出去網站會壞掉。參數是 git diff 的範圍。
markers() {
  git diff --check "$@" 2>/dev/null | grep "conflict marker"
}

# 網站的檔案都在 HEAD 裡，首頁也是完整的（最後有 </html>）：被搬走、改名或只存了一半的 docs/index.html 推上去，網站就打不開了。
site_ok() {
  local f
  for f in docs/index.html docs/sw.js docs/manifest.webmanifest; do
    if ! git cat-file -e "HEAD:$f" 2>/dev/null; then echo "要發布的版本裡沒有 $f（可能被搬走或改了名字），推上去網站會壞掉。"; return 1; fi
  done
  if ! git show HEAD:docs/index.html | tail -c 1024 | grep -q '</html>'; then
    echo "要發布的 docs/index.html 不完整（最後沒有 </html>，可能只存了一半），推上去網站會壞掉。"
    return 1
  fi
}

# commit 上的名字和 email 會公開在 GitHub 上。還沒設定時，問一次並只存在這個資料夾的設定裡。
need_identity() {
  [ -n "$(git config user.name)" ] && [ -n "$(git config user.email)" ] && return 0
  echo
  echo "第一次在這台電腦發布，請設定 commit 上顯示的名字和 email（會公開在 GitHub 上）。"
  echo "不想公開 email 的話，可以用 GitHub 設定裡 Emails 頁面上的 noreply 地址。"
  local name email
  read -r -p "名字：" name || name=
  read -r -p "Email：" email || email=
  if [ -z "$name" ] || [ -z "$email" ]; then
    echo "沒有輸入名字或 email。"
    return 1
  fi
  git config user.name "$name" && git config user.email "$email"
}

if ! git --version >/dev/null 2>&1; then
  echo "這台 Mac 還沒有 Git。"
  echo "如果跳出安裝「命令列開發者工具」的視窗，請按「安裝」，裝好後再點一次這個檔案。"
  echo "沒有跳出來的話，打開「終端機」，輸入 xcode-select --install 再按 Enter。"
  finish 1
fi
if [ ! -e .git ] || ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "這個資料夾不是開口練習室的 Git repo（找不到 .git），沒辦法發布。"
  finish 1
fi
# 之前和 GitHub 合併到一半沒有完成（或其他程式開始的合併、cherry-pick、revert）：在那上面再 commit 可能弄丟手動解決的衝突，所以先不動。
ABORT=$(unfinished)
if [ -n "$ABORT" ]; then
  echo "之前把你的變更和 GitHub 上的版本合在一起的動作還沒完成，所以這次什麼都沒做。"
  echo "如果你已經手動解決了衝突，請找人幫忙完成。不然，先關掉其他用 Git 的程式（例如 VS Code），"
  echo "在終端機進到這個資料夾執行：$ABORT，再點一次這個檔案。"
  finish 1
fi
# 有檔案的衝突還沒解決（例如 VS Code 拉取 GitHub 的版本後，把你暫存的變更拿回來時衝突）：檔案裡還有衝突標記。
# 這時加進 commit 會把衝突當成已經解決，標記就會發布出去，所以先不動。
if [ -n "$(git ls-files -u)" ]; then
  echo "這個資料夾裡有檔案的衝突還沒解決（檔案裡還留著 <<<<<<<、>>>>>>> 這類的行），所以這次什麼都沒做。"
  echo "發布出去的話網站會壞掉。請找人幫忙解決衝突後，再點一次這個檔案。"
  finish 1
fi
# 只從 main 發布：在別的分支上發布，會把那個分支的東西推到 GitHub 的 main。
BRANCH=$(git symbolic-ref -q --short HEAD)
if [ "$BRANCH" != main ]; then
  echo "這個資料夾現在不在 main 分支上（${BRANCH:-沒有在任何分支上}），所以這次什麼都沒做。"
  echo "在別的分支上發布，會把那個分支的東西推到 GitHub 的 main。請先切回 main（例如在 VS Code 左下角選 main），再點一次這個檔案。"
  finish 1
fi

echo "== [1/3] 要發布的變更"
# repo 裡原有的檔案（改過的、刪掉的），加上 docs/、test/、tools/ 裡新的網頁、程式和圖示，和教練伺服器的程式、
# package.json 與 render.yaml（git 的 glob 不會跨資料夾）。
# 新檔案一個一個加：某一類一個都沒有時（例如 docs/ 裡唯一的 .js 被刪掉了），git add 不會因為「沒有符合的檔案」而停下來，
# 下面的檢查才能說明哪裡不對。
git add -u || failed
git -c core.quotepath=false ls-files -z -o --exclude-standard -- ':(glob)docs/*.html' ':(glob)docs/*.js' ':(glob)docs/*.webmanifest' ':(glob)docs/icons/*.png' \
  ':(glob)test/*.js' ':(glob)test/*.sh' ':(glob)tools/*.js' ':(glob)server/*.js' ':(glob)server/package.json' ':(glob)render.yaml' \
  | while IFS= read -r -d '' f; do git add -- "$f" || exit 1; done || failed
if [ -n "$(markers --cached)" ]; then
  echo
  markers --cached
  git reset -q
  echo
  echo "要發布的檔案裡還留著衝突標記（<<<<<<<、=======、>>>>>>> 這類的行，見上面），發布出去的話網站會壞掉。"
  echo "這次什麼都沒做。請找人幫忙解決衝突後，再點一次這個檔案。"
  finish 1
fi
if git diff --cached --quiet; then
  echo "這個資料夾沒有新的變更。"
else
  echo
  git -c core.quotepath=false status --short
  echo
  echo "開頭是 ?? 的不會發布，只留在這個資料夾（docs/、test/、tools/ 裡只有網頁、程式和圖示會發布，server/ 裡只有程式和 package.json）。"
  if ! ask "要把其他變更發布到公開的 GitHub repo 嗎？"; then
    git reset -q
    echo
    echo "已取消，沒有發布任何東西。"
    finish 0
  fi
  if ! need_identity; then
    git reset -q
    echo
    echo "已取消，沒有發布任何東西。"
    finish 1
  fi
  git commit -q -m "Update kaikou practice room" || failed
  COMMITTED=1
  # 記下這個 commit 寫下的時間（rebase 會保留），之後用來認出它。
  OURTIME=$(git log -1 --format=%at HEAD)
fi

echo
echo "== [2/3] 從 GitHub 取得最新的版本"
git fetch origin +refs/heads/main:refs/remotes/origin/main || failed
if ! git rebase origin/main; then
  if rebasing; then
    git rebase --abort
    if rebasing; then
      echo
      echo "你的變更和 GitHub 上的版本衝突，而且沒辦法自動復原（可能有其他程式，例如 VS Code，正在用 Git）。"
      echo "這次沒有發布任何東西。請關掉其他程式，再在這個資料夾執行：git rebase --abort"
      failed
    fi
    echo
    echo "你的變更和 GitHub 上的版本衝突，所以這次沒有發布任何東西。"
    echo "你的檔案保持原樣。請找人幫忙把兩個版本合在一起。"
    failed
  fi
  echo
  echo "沒辦法把你的變更和 GitHub 上的版本合在一起（見上面的訊息）。"
  failed
fi

AHEAD=$(git rev-list --count origin/main..HEAD) || failed
if [ "$AHEAD" = 0 ]; then
  echo
  echo "已經和 GitHub 上的版本一樣，沒有要發布的東西。"
  finish 0
fi
# 只有「領先的那一個 commit 就是上面確認過的那個」時才直接推送。GitHub 上已經有一樣的變更時，rebase 會把它丟掉，
# 這時領先的是別的 commit，要先列出來問你。
HEADTIME=$(git log -1 --format=%at HEAD)
if ! { [ "$COMMITTED" = 1 ] && [ "$AHEAD" = 1 ] && [ -n "$OURTIME" ] && [ "$HEADTIME" = "$OURTIME" ]; }; then
  echo
  echo "這台電腦上的這些 commit 還沒上 GitHub："
  git -c core.quotepath=false log --oneline origin/main..HEAD
  echo
  echo "它們改到的檔案："
  git -c core.quotepath=false diff --name-status origin/main HEAD
  echo
  if ! ask "要把這些全部發布到公開的 GitHub repo 嗎？"; then
    echo
    echo "沒有發布，這些 commit 只留在這台電腦。"
    finish 0
  fi
fi

if [ -n "$(markers origin/main HEAD)" ]; then
  echo
  markers origin/main HEAD
  echo
  echo "要發布的 commit 裡還留著衝突標記（<<<<<<<、=======、>>>>>>> 這類的行，見上面），發布出去的話網站會壞掉。"
  echo "這次沒有發布任何東西，commit 只留在這台電腦。請找人幫忙解決衝突後，再點一次這個檔案。"
  finish 1
fi
if ! site_ok; then
  echo "這次沒有發布任何東西，commit 只留在這台電腦。請把檔案放回去（或改回完整的版本）後，再點一次這個檔案。"
  finish 1
fi

echo
echo "== [3/3] 推送到 GitHub"
# 先不讓 Git 開口問帳號試一次：存好的登入還能用就直接推送，不能用時才說明要輸入什麼。
if ! GIT_TERMINAL_PROMPT=0 git push --dry-run -q origin HEAD:main >/dev/null 2>&1; then
  echo "GitHub 會請你登入（這台 Mac 第一次推送，或之前的權杖過期時才需要）："
  echo "- Username：你的 GitHub 帳號。"
  echo "- Password：貼上 GitHub 的 Personal access token（不是登入密碼）。貼上時畫面不會顯示，貼完按 Enter。"
  echo "  建立方法：github.com 右上角頭像 → Settings → Developer settings → Personal access tokens"
  echo "  → Fine-grained tokens → Generate new token；Repository access 選 kaikou-practice，"
  echo "  Permissions 的 Contents 選 Read and write。Mac 會把它存進鑰匙圈，到期前都不用再輸入。"
  echo
fi
git push origin HEAD:main || failed
echo
echo "完成。GitHub Pages 大約 1 分鐘後更新。"
finish 0
