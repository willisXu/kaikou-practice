#!/bin/bash
# 推送到GitHub.command（Mac 版發布腳本）的測試：用一個本機的「GitHub」（bare repo）和這個 repo 的複本，
# 照著學員會遇到的情況跑一遍，檢查發布了什麼、留下了什麼。不會碰到真的 GitHub，也不會改到這個資料夾。
# 執行：bash test/publish.sh（Mac 或 Linux，需要 git；Windows 可以在 Git Bash 裡跑）。
# 推送到GitHub.bat（Windows 版）做的是同樣的檢查，但這裡沒辦法執行它。
REPO=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT_SRC="$REPO/推送到GitHub.command"
T=$(mktemp -d)
export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL="$T/gitconfig"
printf '[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n' > "$GIT_CONFIG_GLOBAL"
export HOME="$T/home"; mkdir -p "$HOME"
CMD='推送到GitHub.command'
pass=0; fail=0
ok() { if eval "$2"; then echo "ok   $1"; pass=$((pass+1)); else echo "FAIL $1   [$2]"; fail=$((fail+1)); echo "----- output:"; cat "$T/out"; echo "-----"; fi; }

# Replaces line n of a file (macOS sed and GNU sed differ in -i, so awk does it).
setline() { awk -v n="$2" -v t="$3" 'NR == n { print t; next } { print }' "$1" > "$1.new" && mv "$1.new" "$1"; }
seed() { # a fresh bare "GitHub" with this repo and the script (executable), another clone, and the learner's clone
  rm -rf "$T/remote.git" "$T/work" "$T/other"
  git clone -q --bare "$REPO" "$T/remote.git"
  git clone -q "$T/remote.git" "$T/other"
  cp "$SCRIPT_SRC" "$T/other/$CMD"
  (cd "$T/other" && git config user.name Seed && git config user.email seed@example.com && git add "$CMD" && git update-index --chmod=+x "$CMD" && git commit -qm "add mac script" && git push -q origin HEAD:main)
  git clone -q "$T/remote.git" "$T/work"
  (cd "$T/work" && git config user.name Me && git config user.email me@example.com)
}
remote_edit() { # GitHub moves on: line 1 of the page changes there
  (cd "$T/other" && git pull -q && setline docs/index.html 1 "$1" && git commit -qam "remote edit" && git push -q origin HEAD:main)
}
run() { # runs the script with this typed input
  printf "$1" | bash "$T/work/$CMD" > "$T/out" 2>&1; echo $? > "$T/code"
}
remote_head() { git --git-dir="$T/remote.git" rev-parse main; }
code() { cat "$T/code"; }
has() { grep -qF -- "$1" "$T/out"; }
markers_on_github() { git --git-dir="$T/remote.git" show main:docs/index.html | grep -qE '^(<<<<<<<|=======|>>>>>>>)'; }

# S1 nothing to do
seed; R0=$(remote_head); run ''
ok "S1 up to date: message, exit 0, remote unchanged" '[ "$(code)" = 0 ] && has "已經和 GitHub 上的版本一樣" && [ "$(remote_head)" = "$R0" ]'

# S2 publish a docs change
seed; echo '<!-- s2 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S2 change + Y: pushed with the fixed message, exit 0" '[ "$(code)" = 0 ] && has "完成" && [ "$(git --git-dir=$T/remote.git log -1 --format=%s main)" = "Update kaikou practice room" ] && git --git-dir=$T/remote.git show main:docs/index.html | grep -q "s2"'
ok "S2 the script itself stays executable in git" '[ "$(git --git-dir=$T/remote.git ls-tree main -- "$CMD" | cut -c1-6)" = 100755 ]'

# S3 cancel
seed; R0=$(remote_head); echo '<!-- s3 -->' >> "$T/work/docs/index.html"; run 'n\n'
ok "S3 change + N: cancelled, nothing pushed, change kept and unstaged" '[ "$(code)" = 0 ] && has "已取消" && [ "$(remote_head)" = "$R0" ] && grep -q s3 "$T/work/docs/index.html" && [ -z "$(cd $T/work && git diff --cached --name-only)" ] && [ "$(cd $T/work && git rev-parse HEAD)" = "$R0" ]'

# S4 untracked root file is listed with ?? and not published
seed; echo note > "$T/work/notes.txt"; echo '<!-- s4 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S4 untracked root file shown as ?? and not published" '[ "$(code)" = 0 ] && has "?? notes.txt" && ! git --git-dir=$T/remote.git cat-file -e main:notes.txt 2>/dev/null && git --git-dir=$T/remote.git show main:docs/index.html | grep -q s4'

# S5 GitHub moved on (no conflict): rebase, then push without a second question
seed; (cd "$T/other" && git pull -q && echo "remote line" >> README.md && git commit -qam "remote change" && git push -q origin HEAD:main)
echo '<!-- s5 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S5 GitHub ahead: rebased and pushed, no extra question" '[ "$(code)" = 0 ] && has "完成" && ! has "還沒上 GitHub" && git --git-dir=$T/remote.git show main:README.md | grep -q "remote line" && git --git-dir=$T/remote.git show main:docs/index.html | grep -q s5'

# S6 conflict
seed; remote_edit "<!-- remote first line -->"
R0=$(remote_head); setline "$T/work/docs/index.html" 1 "<!-- local first line -->"; run 'y\n'
ok "S6 conflict: nothing published, rebase undone, local change kept" '[ "$(code)" = 1 ] && has "衝突" && has "沒有成功" && [ "$(remote_head)" = "$R0" ] && [ ! -d "$T/work/.git/rebase-merge" ] && [ ! -d "$T/work/.git/rebase-apply" ] && head -1 "$T/work/docs/index.html" | grep -q "local first line"'

# S7 a commit made some other way: listed and asked
seed; R0=$(remote_head); (cd "$T/work" && echo x >> tools/artifact.js && git commit -qam "made in VS Code"); run 'n\n'
ok "S7 other local commit + N: listed with its files, kept local" '[ "$(code)" = 0 ] && has "還沒上 GitHub" && has "made in VS Code" && has "tools/artifact.js" && has "只留在這台電腦" && [ "$(remote_head)" = "$R0" ]'
run 'y\n'
ok "S7 other local commit + Y: published" '[ "$(code)" = 0 ] && has "完成" && [ "$(git --git-dir=$T/remote.git log -1 --format=%s main)" = "made in VS Code" ]'

# S8 GitHub already has the same change: the rebase drops ours, so the other local commit must be asked about
seed; (cd "$T/other" && git pull -q && echo "<!-- same -->" >> docs/index.html && git commit -qam "same change on GitHub" && git push -q origin HEAD:main)
(cd "$T/work" && echo y >> tools/make-icons.js && GIT_AUTHOR_DATE="2026-01-01T00:00:00" git commit -qam "older local commit")
echo "<!-- same -->" >> "$T/work/docs/index.html"; R0=$(remote_head); run 'y\nn\n'
ok "S8 our change already on GitHub: the remaining local commit is listed and kept on N" '[ "$(code)" = 0 ] && has "older local commit" && has "只留在這台電腦" && [ "$(remote_head)" = "$R0" ]'

# S9 no identity yet: asks once and stores it in this repo only (Y is typed and Enter pressed, as the prompt says)
seed; (cd "$T/work" && git config --unset user.name && git config --unset user.email); echo '<!-- s9 -->' >> "$T/work/docs/index.html"
run 'y\nTester\nt@example.com\n'
ok "S9 identity asked, stored locally, used for the commit" '[ "$(code)" = 0 ] && has "第一次在這台電腦發布" && [ "$(git --git-dir=$T/remote.git log -1 --format="%an <%ae>" main)" = "Tester <t@example.com>" ] && [ "$(cd $T/work && git config --local user.name)" = Tester ] && [ -z "$(git config --global user.name)" ]'
seed; R0=$(remote_head); (cd "$T/work" && git config --unset user.name && git config --unset user.email); echo '<!-- s9b -->' >> "$T/work/docs/index.html"
run 'y\n\n'
ok "S9b identity left empty: cancelled, nothing committed or pushed, change unstaged" '[ "$(code)" = 1 ] && has "已取消" && [ "$(remote_head)" = "$R0" ] && [ "$(cd $T/work && git rev-parse HEAD)" = "$R0" ] && [ -z "$(cd $T/work && git diff --cached --name-only)" ]'
seed; echo '<!-- s9c -->' >> "$T/work/docs/index.html"; run '\nmaybe\ny\n'
ok "S9c an empty or unclear answer asks again" '[ "$(code)" = 0 ] && has "完成" && git --git-dir=$T/remote.git show main:docs/index.html | grep -q s9c'

# S10 no git on PATH
seed; mkdir -p "$T/bin"; ln -sf "$(command -v dirname)" "$T/bin/dirname"
printf '' | PATH="$T/bin" /bin/bash "$T/work/$CMD" > "$T/out" 2>&1; echo $? > "$T/code"
ok "S10 no git: explains how to install it" '[ "$(code)" = 1 ] && has "還沒有 Git" && has "xcode-select --install"'

# S11 GitHub rejects the push
seed; printf '#!/bin/sh\necho rejected-by-hook >&2\nexit 1\n' > "$T/remote.git/hooks/pre-receive"; chmod +x "$T/remote.git/hooks/pre-receive"
R0=$(remote_head); echo '<!-- s11 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S11 push rejected: failure message, exit 1, no login hint" '[ "$(code)" = 1 ] && has "沒有成功" && has "rejected-by-hook" && ! has "Personal access token" && [ "$(remote_head)" = "$R0" ]'

# S12 push needs a login that is not stored: explain the token before pushing
seed; (cd "$T/work" && git remote set-url --push origin "$T/nowhere.git"); echo '<!-- s12 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S12 push cannot authenticate: token hint shown, then failure" '[ "$(code)" = 1 ] && has "Personal access token" && has "沒有成功"'

# S13 not a git folder
mkdir -p "$T/plain"; cp "$SCRIPT_SRC" "$T/plain/$CMD"; printf '' | bash "$T/plain/$CMD" > "$T/out" 2>&1; echo $? > "$T/code"
ok "S13 folder without .git: explains and stops" '[ "$(code)" = 1 ] && has "找不到 .git"'

# S14 an untracked file in the way of GitHub's version
seed; (cd "$T/other" && git pull -q && echo theirs > extra.txt && git add extra.txt && git commit -qm "add extra" && git push -q origin HEAD:main)
R0=$(remote_head); echo mine > "$T/work/extra.txt"; echo '<!-- s14 -->' >> "$T/work/docs/index.html"; run 'y\n'
ok "S14 untracked file would be overwritten: nothing published, my file kept" '[ "$(code)" = 1 ] && has "沒有成功" && [ "$(remote_head)" = "$R0" ] && [ "$(cat $T/work/extra.txt)" = mine ] && [ ! -d "$T/work/.git/rebase-merge" ]'

# S15 deleted tracked file outside docs/test/tools is published (git add -u), like the .bat
seed; (cd "$T/work" && rm package-lock.json); run 'y\n'
ok "S15 deleting a tracked file is published" '[ "$(code)" = 0 ] && ! git --git-dir=$T/remote.git cat-file -e main:package-lock.json 2>/dev/null'

# S16 an unfinished rebase (a conflict left from before): nothing is committed on top of it
seed; remote_edit "<!-- remote first line -->"
(cd "$T/work" && setline docs/index.html 1 "<!-- local first line -->" && git commit -qam "local edit" && git fetch -q origin && git rebase origin/main >/dev/null 2>&1); H0=$(cd "$T/work" && git rev-parse HEAD); R0=$(remote_head)
echo '<!-- s16 -->' >> "$T/work/docs/style-note.txt"; run 'y\n'
ok "S16 unfinished rebase: refuses, commits nothing, leaves the rebase as it was" '[ "$(code)" = 1 ] && has "還沒完成" && has "git rebase --abort" && [ "$(remote_head)" = "$R0" ] && [ "$(cd $T/work && git rev-parse HEAD)" = "$H0" ] && [ -d "$T/work/.git/rebase-merge" ]'

# S17 a merge left unfinished by another program
seed; remote_edit "<!-- remote first line -->"
(cd "$T/work" && setline docs/index.html 1 "<!-- local first line -->" && git commit -qam "local edit" && git fetch -q origin && git merge origin/main >/dev/null 2>&1); R0=$(remote_head); run 'y\n'
ok "S17 unfinished merge: refuses and publishes nothing" '[ "$(code)" = 1 ] && has "還沒完成" && has "git merge --abort" && [ "$(remote_head)" = "$R0" ] && [ -f "$T/work/.git/MERGE_HEAD" ]'

# S18 changes taken back after pulling GitHub's version conflict (as VS Code does: stash, pull, stash pop): the conflict
# is not finished, and no Git state file says so; staging it would mark it solved and publish the markers
seed; remote_edit "<!-- remote first line -->"
(cd "$T/work" && setline docs/index.html 1 "<!-- my first line -->" && git stash -q && git pull -q --ff-only && git stash pop >/dev/null 2>&1); R0=$(remote_head); run 'y\n'
ok "S18 conflict left by taking changes back: refuses, publishes no markers" '[ "$(code)" = 1 ] && has "衝突還沒解決" && [ "$(remote_head)" = "$R0" ] && ! markers_on_github && [ -n "$(cd $T/work && git ls-files -u)" ]'

# S19 a cherry-pick that stopped at a conflict
seed; (cd "$T/work" && git checkout -q -b experiment && setline docs/index.html 1 "<!-- experiment -->" && git commit -qam "experiment" && git checkout -q main && setline docs/index.html 1 "<!-- main edit -->" && git commit -qam "main edit" && git cherry-pick experiment >/dev/null 2>&1)
R0=$(remote_head); run 'y\n'
ok "S19 unfinished cherry-pick: refuses, says how to undo it, publishes nothing" '[ "$(code)" = 1 ] && has "還沒完成" && has "git cherry-pick --abort" && [ "$(remote_head)" = "$R0" ] && ! markers_on_github'

# S19b a revert that stopped at a conflict
seed; (cd "$T/work" && setline docs/index.html 1 "<!-- first -->" && git commit -qam "first" && setline docs/index.html 1 "<!-- second -->" && git commit -qam "second" && git revert --no-edit HEAD~1 >/dev/null 2>&1)
R0=$(remote_head); run 'y\n'
ok "S19b unfinished revert: refuses, says how to undo it, publishes nothing" '[ "$(code)" = 1 ] && has "還沒完成" && has "git revert --abort" && [ "$(remote_head)" = "$R0" ] && ! markers_on_github'

# S20 a file still holding conflict markers was marked solved by hand (git add in another program)
seed; R0=$(remote_head); (cd "$T/work" && printf '<<<<<<< Updated upstream\n<!-- a -->\n=======\n<!-- b -->\n>>>>>>> Stashed changes\n' >> docs/index.html && git add docs/index.html); run 'y\n'
ok "S20 staged markers: refuses before committing, unstages, publishes nothing" '[ "$(code)" = 1 ] && has "衝突標記" && has "docs/index.html" && [ "$(remote_head)" = "$R0" ] && [ "$(cd $T/work && git rev-parse HEAD)" = "$R0" ] && [ -z "$(cd $T/work && git diff --cached --name-only)" ]'

# S21 a commit made some other way holds conflict markers
seed; R0=$(remote_head); (cd "$T/work" && printf '<<<<<<< HEAD\n<!-- a -->\n=======\n<!-- b -->\n>>>>>>> other\n' >> docs/index.html && git commit -qam "merged in VS Code"); run 'y\n'
ok "S21 markers in a local commit: not pushed, the commit stays on this computer" '[ "$(code)" = 1 ] && has "衝突標記" && [ "$(remote_head)" = "$R0" ] && ! markers_on_github'

echo "passed $pass, failed $fail"
rm -rf "$T"
[ "$fail" = 0 ]
