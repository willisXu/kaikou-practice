@echo off
rem Kaikou practice room: sync with GitHub, commit local changes and push them.
rem GitHub Pages updates about a minute after a successful push.
cd /d "%~dp0"

echo == [1/3] Get the latest version from GitHub
git pull --rebase --autostash
if errorlevel 1 goto failed

echo.
echo == [2/3] Commit local changes
git add -A
git diff --cached --quiet
if not errorlevel 1 (
    echo No changes to publish.
    goto done
)
git commit -m "Update kaikou practice room"
if errorlevel 1 goto failed

echo.
echo == [3/3] Push to GitHub
git push
if errorlevel 1 goto failed
echo.
echo Done. GitHub Pages will update in about a minute.
goto done

:failed
echo.
echo FAILED - see the messages above. Nothing was published.

:done
pause
