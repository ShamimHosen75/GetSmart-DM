@echo off
rem SIDM companion: download the newest yt-dlp.exe into this folder.
setlocal EnableExtensions
cd /d "%~dp0"
set "YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
set "TMPFILE=%TEMP%\gsdm-yt-dlp-%RANDOM%.exe"

where curl >nul 2>&1
if errorlevel 1 (
  echo ERROR: curl.exe was not found. Windows 10 version 1803 or newer is required.
  goto :fail
)

if exist "%~dp0yt-dlp.exe" (
  <nul set /p "=Current yt-dlp: "
  "%~dp0yt-dlp.exe" --version
)
echo Downloading the newest yt-dlp...
curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 --progress-bar -o "%TMPFILE%" "%YTDLP_URL%"
if errorlevel 1 (
  echo ERROR: Download failed: %YTDLP_URL%
  echo Check your internet connection and try again.
  goto :fail
)
move /y "%TMPFILE%" "%~dp0yt-dlp.exe" >nul
if errorlevel 1 (
  echo ERROR: Could not replace yt-dlp.exe. Close the browser so no download is running, then try again.
  goto :fail
)
<nul set /p "=Updated yt-dlp: "
"%~dp0yt-dlp.exe" --version
if errorlevel 1 (
  echo ERROR: The new yt-dlp.exe does not run.
  goto :fail
)
echo.
echo Done.
pause
exit /b 0

:fail
if exist "%TMPFILE%" del /q "%TMPFILE%" >nul 2>&1
echo.
echo Update did NOT finish. See the message above.
pause
exit /b 1
