@echo off
rem Kaikou practice room: publish your changes to the public GitHub repo willisXu/kaikou-practice.
rem Only files that are already in the repo, new pages, code and icons in docs\, test\ and tools\, and the coach
rem server's code, package.json and render.yaml (by file type) are published. Anything else you put in this folder (an exported backup, a 4/3/2 recording, files left by a merge
rem tool) may be private and stays on this computer. Publishing happens only from the main branch, and never when the
rem version to publish lacks the site's files or holds an incomplete docs\index.html.
rem Commits made on this computer some other way are listed and published only after you say Y.
rem GitHub Pages updates about a minute after a successful push.
chcp 65001 >nul
cd /d "%~dp0"
rem Long lists must not stop in a pager waiting for q.
set "GIT_PAGER=cat"
set "COMMITTED=0"

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed or not on PATH.
    goto failed
)

rem An earlier attempt to combine with GitHub (or a merge, cherry-pick or revert started in another program) is not
rem finished: committing on top of it could lose conflict fixes made by hand, so nothing is done until it is finished.
if exist ".git\rebase-merge" goto unfinished
if exist ".git\rebase-apply" goto unfinished
if exist ".git\MERGE_HEAD" goto unfinished
if exist ".git\CHERRY_PICK_HEAD" goto unfinished
if exist ".git\REVERT_HEAD" goto unfinished
rem A file whose conflict is not solved yet (for example after changes set aside were taken back, as VS Code does when
rem it pulls): staging it would mark the conflict solved and publish its conflict markers, which break the page.
for /f %%u in ('git ls-files -u') do goto conflicted
rem Publish only from main: publishing from another branch would push that branch onto main on GitHub.
set "BRANCH="
for /f "delims=" %%b in ('git symbolic-ref -q --short HEAD') do set "BRANCH=%%b"
if not "%BRANCH%"=="main" goto notmain

echo == [1/3] Changes to publish
rem Files already in the repo (changed or deleted), new pages, code and icons in docs\, test\ and tools\, and the coach
rem server's code, package.json and render.yaml (Git's glob does not cross folders). New files are added one by one: when one kind has none at all (the only .js in docs\
rem deleted, say), git add does not stop for want of a match, and the checks below can say what is wrong.
git add -u
if errorlevel 1 goto failed
for /f "delims=" %%f in ('git -c "core.quotepath=false" ls-files -o --exclude-standard -- ":(glob)docs/*.html" ":(glob)docs/*.js" ":(glob)docs/*.webmanifest" ":(glob)docs/icons/*.png" ":(glob)test/*.js" ":(glob)test/*.sh" ":(glob)tools/*.js" ":(glob)server/*.js" ":(glob)server/package.json" ":(glob)render.yaml"') do (
    git add -- "%%f"
    if errorlevel 1 goto failed
)
git diff --cached --check | findstr /c:"conflict marker"
if not errorlevel 1 goto stagedmarkers
git diff --cached --quiet
if errorlevel 1 goto review
echo No new changes in this folder.
goto sync

:review
echo.
git -c core.quotepath=false status --short
echo.
echo Lines starting with ?? are NOT published; they stay in this folder only (in docs\, test\ and tools\, only
echo pages, code and icons are published).
choice /c YN /m "Publish the other changes to the public GitHub repo"
if errorlevel 2 goto cancelled
rem The name and email on a commit are public on GitHub. When this computer has none set, ask once and keep them
rem for this folder only (Git would otherwise refuse, or make them up from the computer's name).
set "GNAME="
for /f "delims=" %%n in ('git config user.name') do set "GNAME=%%n"
if defined GNAME goto havename
echo.
echo First publish from this computer: set the name and email shown on your commits (public on GitHub).
echo To keep your email private, use the noreply address on the Emails page of your GitHub settings.
set /p "GNAME=Name: "
if not defined GNAME goto noidentity
git config user.name "%GNAME%"
:havename
set "GMAIL="
for /f "delims=" %%m in ('git config user.email') do set "GMAIL=%%m"
if defined GMAIL goto havemail
set /p "GMAIL=Email: "
if not defined GMAIL goto noidentity
git config user.email "%GMAIL%"
:havemail
git -c user.useConfigOnly=true commit -m "Update kaikou practice room"
if errorlevel 1 goto failed
set "COMMITTED=1"
rem Remember when this commit was written (a rebase keeps it), to recognise it later.
set "OURTIME="
for /f %%t in ('git log -1 "--format=%%at" HEAD') do set "OURTIME=%%t"

:sync
echo.
echo == [2/3] Get the latest version from GitHub
git fetch origin +refs/heads/main:refs/remotes/origin/main
if errorlevel 1 goto failed
git rebase origin/main
if not errorlevel 1 goto ahead
if exist ".git\rebase-merge" goto conflict
if exist ".git\rebase-apply" goto conflict
echo.
echo Could not combine your changes with the version on GitHub (see the message above).
goto failed

:conflict
git rebase --abort
if exist ".git\rebase-merge" goto stuck
if exist ".git\rebase-apply" goto stuck
echo.
echo Your changes conflict with the version on GitHub, so nothing was published.
echo Your files are as they were. Ask for help to combine the two versions.
goto failed

:stuck
echo.
echo Your changes conflict with the version on GitHub, and the attempt to combine them could not be undone
echo automatically (another program, such as VS Code, may be using Git). Nothing was published.
echo Close the other program, then run this in this folder:  git rebase --abort
goto failed

:ahead
set "AHEAD=0"
for /f %%n in ('git rev-list --count origin/main..HEAD') do set "AHEAD=%%n"
if "%AHEAD%"=="0" goto uptodate
rem Push without asking only when the one commit ahead is the one just reviewed above. The rebase drops that
rem commit when GitHub already has the same change; then the commit ahead is another one and is listed below.
set "HEADTIME="
for /f %%t in ('git log -1 "--format=%%at" HEAD') do set "HEADTIME=%%t"
if "%COMMITTED%%AHEAD%"=="11" if defined OURTIME if "%HEADTIME%"=="%OURTIME%" goto push
echo.
echo These commits on this computer are not on GitHub yet:
git -c core.quotepath=false log --oneline origin/main..HEAD
echo.
echo Files they change:
git -c core.quotepath=false diff --name-status origin/main HEAD
echo.
choice /c YN /m "Publish all of these to the public GitHub repo"
if errorlevel 2 goto keptlocal

:push
git diff --check origin/main HEAD | findstr /c:"conflict marker"
if not errorlevel 1 goto commitmarkers
rem The site's files must be there and the page complete (it holds the closing html tag, which comes last): a
rem docs\index.html moved, renamed or saved only half way breaks the site.
for %%f in (docs/index.html docs/sw.js docs/manifest.webmanifest) do (
    git cat-file -e "HEAD:%%f" 2>nul
    if errorlevel 1 goto brokensite
)
git show HEAD:docs/index.html > "%TEMP%\kaikou-index-check.html"
if errorlevel 1 goto brokensite
findstr /c:"</html>" "%TEMP%\kaikou-index-check.html" >nul
if errorlevel 1 (
    del "%TEMP%\kaikou-index-check.html" 2>nul
    goto brokensite
)
del "%TEMP%\kaikou-index-check.html" 2>nul
echo.
echo == [3/3] Push to GitHub
git push origin HEAD:main
if errorlevel 1 goto failed
echo.
echo Done. GitHub Pages will update in about a minute.
goto done

:uptodate
echo.
echo Already the same as GitHub. Nothing to publish.
goto done

:keptlocal
echo.
echo Not published. Those commits stay on this computer only.
goto done

:noidentity
git reset -q
echo.
echo No name or email was entered, so nothing was published.
goto done

:cancelled
git reset -q
echo.
echo Cancelled. Nothing was published.
goto done

:unfinished
echo.
echo An earlier attempt to combine your changes with GitHub is not finished, so nothing was done.
echo If you fixed the conflicts by hand, ask for help to finish it. Otherwise close other programs that
echo use Git (such as VS Code), run this in this folder, then run this script again:  git rebase --abort
echo (if a merge was started instead, the command is:  git merge --abort
echo  for a cherry-pick:  git cherry-pick --abort  and for a revert:  git revert --abort)
goto done

:conflicted
echo.
echo A file in this folder still has a conflict that is not solved (it still holds conflict markers),
echo so nothing was done. Publishing it would break the page. Ask for help to solve the conflict,
echo then run this script again.
goto done

:stagedmarkers
git reset -q
echo.
echo The files to publish still hold conflict markers (see the lines above). Publishing them would
echo break the page, so nothing was done. Ask for help to solve the conflict, then run this script again.
goto done

:notmain
if not defined BRANCH set "BRANCH=no branch"
echo.
echo This folder is not on the main branch (it is on: %BRANCH%), so nothing was done.
echo Publishing from another branch would push that branch onto main on GitHub. Switch back to main
echo (for example in the bottom-left corner of VS Code), then run this script again.
goto done

:brokensite
echo.
echo The version to publish lacks docs\index.html, docs\sw.js or docs\manifest.webmanifest, or its docs\index.html
echo is incomplete (it does not end with the closing html tag; it may have been saved only half way). Publishing it
echo would break the site, so nothing was published: the commits stay on this computer only. Put the files back
echo (or restore the complete page), then run this script again.
goto failed

:commitmarkers
echo.
echo The commits to publish still hold conflict markers (see the lines above). Publishing them would
echo break the page, so nothing was published: the commits stay on this computer only.
echo Ask for help to solve the conflict, then run this script again.
goto failed

:failed
echo.
echo FAILED - see the messages above. Nothing new was published.

:done
pause
