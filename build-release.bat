@echo off
setlocal
set "REPO=%~dp0"
set "DEPLOY=C:\Utilities\stewrd\plugins\stewrd-yt-dlp"

cd /d "%REPO%"
if not exist node_modules call npm install || exit /b 1
call npm run build || exit /b 1

rem data\ holds the plugin's downloaded yt-dlp/ffmpeg binaries and queue
rem state in the deploy folder, so /MIR must not delete it.
robocopy "%REPO%." "%DEPLOY%" /MIR /NFL /NDL /NJH /NP ^
  /XD .git .remember .serena node_modules data ^
  /XF package.json package-lock.json build-release.bat CLAUDE.md ARCHITECTURE.md *.zip
if %ERRORLEVEL% GEQ 8 exit /b 1
echo Deployed to %DEPLOY%
exit /b 0
