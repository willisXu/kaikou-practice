@echo off
rem Kaikou practice room: publish your changes to the public GitHub repo willisXu/kaikou-practice.
rem Only docs\, test\, tools\ and files that are already in the repo are published.
rem Anything else you put in this folder stays on this computer.
rem Commits made on this computer some other way are listed and published only after you say Y.
rem GitHub Pages updates about a minute after a successful push.
chcp 65001 >nul
cd /d "%~dp0"
set "COMMITTED=0"

where git >nul 2>nul
if errorlevel 1 (
    echo Git is not installed or not on PATH.
    goto failed
)

rem An earlier attempt to combine with GitHub (or a merge started in another program) is not finished:
rem committing on top of it could lose conflict fixes made by hand, so nothing is done until it is finished.
if exist ".git\rebase-merge" goto unfinished
if exist ".git\rebase-apply" goto unfinished
if exist ".git\MERGE_HEAD" goto unfinished

echo == [1/3] Changes to publish
for %%d in (docs test tools) do if exist "%%d\" git add -A -- "%%d"
git add -u
if errorlevel 1 goto failed
git diff --cached --quiet
if errorlevel 1 goto review
echo No new changes in this folder.
goto sync

:review
echo.
git -c core.quotepath=false status --short
echo.
echo Lines starting with ?? are NOT published; they stay in this folder only.
choice /c YN /m "Publish the other changes to the public GitHub repo"
if errorlevel 2 goto cancelled
git commit -m "Update kaikou practice room"
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
echo (if a merge was started instead, the command is:  git merge --abort)
goto done

:failed
echo.
echo FAILED - see the messages above. Nothing new was published.

:done
pause
