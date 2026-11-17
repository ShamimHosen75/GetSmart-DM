@echo off
rem SIDM companion: remove the native-messaging registration for Chrome, Edge and Brave.
rem Does not delete any files. Your downloaded videos are never touched.
setlocal EnableExtensions
set "HOST_NAME=com.sidm.host"
rem Name used before the rename to SIDM; removed too if an older install left it.
set "OLD_HOST_NAME=com.getsmartdm.host"

echo Removing SIDM companion registration (current user)...
call :regdel "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"
call :regdel "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%"
call :regdel "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%"
for %%K in ("Google\Chrome" "Microsoft\Edge" "BraveSoftware\Brave-Browser") do (
  reg delete "HKCU\Software\%%~K\NativeMessagingHosts\%OLD_HOST_NAME%" /f >nul 2>&1
)
echo.
echo Done. The browsers can no longer start the companion.
echo You can now delete this folder yourself. Your videos in Downloads\SIDM are kept.
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
