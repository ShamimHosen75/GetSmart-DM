@echo off
rem GetSmart DM companion: remove the native-messaging registration for Chrome, Edge and Brave.
rem Does not delete any files. Your downloaded videos are never touched.
setlocal EnableExtensions
set "HOST_NAME=com.getsmartdm.host"

echo Removing GetSmart DM companion registration (current user)...
call :regdel "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
call :regdel "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
call :regdel "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%"
echo.
echo Done. The browsers can no longer start the companion.
echo You can now delete this folder yourself. Your videos in Downloads\GetSmart DM are kept.
pause
exit /b 0

:regdel
reg query "%~1" >nul 2>&1
if errorlevel 1 (
  echo   not registered: %~1
  exit /b 0
)
reg delete "%~1" /f >nul
if errorlevel 1 (
  echo   ERROR: could not remove %~1
  exit /b 1
)
echo   removed: %~1
exit /b 0
