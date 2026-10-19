#!/bin/bash
# 開口練習室：把這個資料夾的變更發布到公開的 GitHub repo willisXu/kaikou-practice（Mac 版，點兩下就會在「終端機」裡執行）。
# 和 推送到GitHub.bat（Windows 版）做一樣的事：
# - 只發布 docs/、test/、tools/ 與 repo 裡原有的檔案，這個資料夾裡其他新檔案只留在這台電腦。
# - 這台電腦上用別的方式做的、還沒上 GitHub 的 commit，會先列出來，按 Y 才一起發布。
# - 推送成功後，GitHub Pages 約 1 分鐘後更新。
# 只用 macOS 內建的 bash 3.2 就有的功能。

cd "$(dirname "$0")" || exit 1
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

# ask "問題"：按 Y 回傳 0、按 N 回傳 1（讀不到輸入時當作 N）。
ask() {
  local a
  while true; do
    read -r -n 1 -p "$1 (Y/N) " a || { echo; return 1; }
    echo
    case "$a" in
      [Yy]) return 0 ;;
      [Nn]) return 1 ;;
    esac
  done
}

rebasing() {
  [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]
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
# 之前和 GitHub 合併到一半沒有完成（或其他程式開始的合併）：在那上面再 commit 可能弄丟手動解決的衝突，所以先不動。
if rebasing || [ -e "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  echo "之前把你的變更和 GitHub 上的版本合在一起的動作還沒完成，所以這次什麼都沒做。"
  echo "如果你已經手動解決了衝突，請找人幫忙完成。不然，先關掉其他用 Git 的程式（例如 VS Code），"
  echo "在終端機進到這個資料夾執行：git rebase --abort（如果是合併，執行 git merge --abort），再點一次這個檔案。"
  finish 1
fi

echo "== [1/3] 要發布的變更"
for d in docs test tools; do
  if [ -d "$d" ]; then git add -A -- "$d" || failed; fi
done
git add -u || failed
if git diff --cached --quiet; then
  echo "這個資料夾沒有新的變更。"
else
  echo
  git -c core.quotepath=false status --short
  echo
  echo "開頭是 ?? 的不會發布，只留在這個資料夾。"
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
