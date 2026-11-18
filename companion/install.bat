@echo off
rem SIDM companion installer. No admin rights needed.
rem Downloads embedded Python, yt-dlp and ffmpeg into this folder, then
rem registers the native-messaging host for Chrome, Edge and Brave (current user only).
rem "install.bat /quiet" is how the setup program (SIDM-Setup.exe) runs it: no pauses, no progress bars.
setlocal EnableExtensions
rem UTF-8 so the manifest stays valid JSON when the folder path has non-English letters.
chcp 65001 >nul
cd /d "%~dp0"

set "EXT_ID=ejkhmcfjnohjikdgfgkhjficmiaoghma"
set "HOST_NAME=com.sidm.host"
set "PY_VER=3.12.10"
set "PY_URL=https://www.python.org/ftp/python/%PY_VER%/python-%PY_VER%-embed-amd64.zip"
set "YTDLP_URL=https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
set "FFMPEG_URL=https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

set "QUIET="
if /i "%~1"=="/quiet" set "QUIET=1"
set "CURL_PROGRESS=--progress-bar"
if defined QUIET set "CURL_PROGRESS=-sS"
set "HERE=%~dp0"
set "WORK=%TEMP%\gsdm-install-%RANDOM%"
set "MANIFEST=%HERE%%HOST_NAME%.json"
set "LAUNCHER=%HERE%run_host.bat"

echo.
echo SIDM companion installer
echo Folder: %HERE%
echo.

rem ---- 1. Tools that ship with Windows 10 1803 and later
where curl >nul 2>&1
if errorlevel 1 (
  echo ERROR: curl.exe was not found. Windows 10 version 1803 or newer is required.
  goto :fail
)
where tar >nul 2>&1
if errorlevel 1 (
  echo ERROR: tar.exe was not found. Windows 10 version 1803 or newer is required.
  goto :fail
)
if not exist "%HERE%host.py" (
  echo ERROR: host.py is missing. Extract the whole companion ZIP, then run install.bat again.
  goto :fail
)
mkdir "%WORK%" >nul 2>&1

rem ---- 2. Embedded Python
if exist "%HERE%python\python.exe" (
  echo [skip] Python is already present.
  goto :ytdlp
)
echo [1/3] Downloading Python %PY_VER% embeddable...
call :download "%PY_URL%" "%WORK%\python.zip" || goto :fail
mkdir "%HERE%python" >nul 2>&1
tar -xf "%WORK%\python.zip" -C "%HERE%python"
if errorlevel 1 (
  echo ERROR: Could not extract the Python ZIP.
  goto :fail
)

:ytdlp
rem ---- 3. yt-dlp
if exist "%HERE%yt-dlp.exe" (
  echo [skip] yt-dlp.exe is already present. Run update.bat to get the newest version.
  goto :ffmpeg
)
echo [2/3] Downloading yt-dlp...
call :download "%YTDLP_URL%" "%WORK%\yt-dlp.exe" || goto :fail
move /y "%WORK%\yt-dlp.exe" "%HERE%yt-dlp.exe" >nul
if errorlevel 1 (
  echo ERROR: Could not copy yt-dlp.exe into the companion folder.
  goto :fail
)

:ffmpeg
rem ---- 4. ffmpeg + ffprobe
if exist "%HERE%ffmpeg.exe" if exist "%HERE%ffprobe.exe" (
  echo [skip] ffmpeg.exe and ffprobe.exe are already present.
  goto :register
)
echo [3/3] Downloading ffmpeg, about 200 MB...
call :download "%FFMPEG_URL%" "%WORK%\ffmpeg.zip" || goto :fail
mkdir "%WORK%\ffmpeg" >nul 2>&1
tar -xf "%WORK%\ffmpeg.zip" -C "%WORK%\ffmpeg"
if errorlevel 1 (
  echo ERROR: Could not extract the ffmpeg ZIP.
  goto :fail
)
set "FOUND_FFMPEG="
for /r "%WORK%\ffmpeg" %%F in (ffmpeg.exe) do if exist "%%F" set "FOUND_FFMPEG=%%~dpF"
if not defined FOUND_FFMPEG (
  echo ERROR: ffmpeg.exe was not found inside the downloaded ZIP.
  goto :fail
)
copy /y "%FOUND_FFMPEG%ffmpeg.exe" "%HERE%ffmpeg.exe" >nul || goto :copyfail
copy /y "%FOUND_FFMPEG%ffprobe.exe" "%HERE%ffprobe.exe" >nul || goto :copyfail

:register
rem ---- 5. Launcher and native-messaging manifest
> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo "%%~dp0python\python.exe" "%%~dp0host.py" %%*

set "JSON_PATH=%LAUNCHER:\=\\%"
> "%MANIFEST%" echo {
>> "%MANIFEST%" echo   "name": "%HOST_NAME%",
>> "%MANIFEST%" echo   "description": "SIDM companion",
>> "%MANIFEST%" echo   "path": "%JSON_PATH%",
>> "%MANIFEST%" echo   "type": "stdio",
>> "%MANIFEST%" echo   "allowed_origins": ["chrome-extension://%EXT_ID%/"]
>> "%MANIFEST%" echo }

echo.
echo Registering for Chrome, Edge and Brave (current user)...
call :regadd "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" || goto :fail
call :regadd "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" || goto :fail
call :regadd "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" || goto :fail

rem ---- 6. Verify
echo.
echo Checking the tools...
"%HERE%python\python.exe" -c "import sys; print('Python ' + sys.version.split()[0])"
if errorlevel 1 (
  echo ERROR: The embedded Python does not run.
  goto :fail
)
<nul set /p "=yt-dlp "
"%HERE%yt-dlp.exe" --version
if errorlevel 1 (
  echo ERROR: yt-dlp.exe does not run.
  goto :fail
)
"%HERE%ffmpeg.exe" -version | findstr /b /c:"ffmpeg version"
if errorlevel 1 (
  echo ERROR: ffmpeg.exe does not run.
  goto :fail
)
echo.
echo Companion self-check:
"%HERE%python\python.exe" "%HERE%host.py" --check
if errorlevel 1 (
  echo ERROR: host.py --check failed. See host.log in this folder.
  goto :fail
)

rmdir /s /q "%WORK%" >nul 2>&1
echo.
echo Done. Restart Chrome, Edge or Brave, then open SIDM: the companion should show as connected.
echo Keep this folder where it is. If you move it, run install.bat again.
echo.
if not defined QUIET pause
exit /b 0

rem ---------------------------------------------------------------- helpers

:download
rem %1 = URL, %2 = target file
curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 %CURL_PROGRESS% -o "%~2" "%~1"
if errorlevel 1 (
  echo ERROR: Download failed: %~1
  echo Check your internet connection and try again, or follow "Manual setup" in README.md.
  exit /b 1
)
exit /b 0

:regadd
reg add "%~1" /ve /t REG_SZ /d "%MANIFEST%" /f >nul
if errorlevel 1 (
  echo ERROR: Could not write registry key %~1
  exit /b 1
)
echo   %~1
exit /b 0

:copyfail
echo ERROR: Could not copy ffmpeg.exe / ffprobe.exe into %HERE%
goto :fail

:fail
if defined WORK rmdir /s /q "%WORK%" >nul 2>&1
echo.
echo Install did NOT finish. See the message above.
echo.
if not defined QUIET pause
exit /b 1
