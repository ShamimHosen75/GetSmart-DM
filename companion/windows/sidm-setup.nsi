; SIDM for Windows: setup program for the companion (Step 6).
;
; One file the user double-clicks, like any Windows program:
;   - installs for the current user only, no admin rights, into
;     %LOCALAPPDATA%\Programs\SIDM (a fixed folder, so the uninstaller only ever
;     removes SIDM's own files),
;   - runs install.bat /quiet with no console window: it downloads embedded
;     Python, yt-dlp and ffmpeg and registers the native-messaging host
;     com.sidm.host for Chrome, Edge and Brave (HKCU),
;   - adds Start menu entries and an "Installed apps" entry with an uninstaller.
; The uninstaller removes the registration and SIDM's own files. Downloaded
; videos (Downloads\SIDM) are never touched.
;
; Built on Linux or Windows with NSIS 3: scripts/build_setup.py passes
; VERSION, SRC (the companion folder), ICON and OUTFILE.

Unicode true
Target amd64-unicode ; 64-bit Windows 10/11, like the embedded Python it downloads
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true
SetDateSave off ; same input, same bytes: the release ZIPs stay reproducible

!ifndef VERSION
  !error "VERSION is required (scripts/build_setup.py passes it)"
!endif

!define APP "SIDM"
!define APP_LONG "SIDM - Smart Internet Download Manager"
!define HOST "com.sidm.host"
!define OLD_HOST "com.getsmartdm.host"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\SIDM"

Name "${APP_LONG}"
Caption "${APP} ${VERSION} Setup"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\SIDM"
BrandingText "${APP} ${VERSION}"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_LONG}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "SIDM"

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install ${APP} for Windows"
!define MUI_WELCOMEPAGE_TEXT "This adds the ${APP} program that the ${APP} browser extension works with. It brings:$\r$\n$\r$\n  - YouTube downloads$\r$\n  - downloads over several connections, with the speed limit$\r$\n  - joining every kind of video into one MP4$\r$\n$\r$\nIt installs for you only and needs no administrator rights. Setup downloads Python, yt-dlp and ffmpeg (about 200 MB), so keep the internet on.$\r$\n$\r$\nInstall the ${APP} extension in Chrome, Edge or Brave first."
!define MUI_FINISHPAGE_TITLE "${APP} is ready"
!define MUI_FINISHPAGE_TEXT "The ${APP} extension finds the program by itself. If it still says the program is missing, restart your browser.$\r$\n$\r$\nYour videos are saved in Downloads\SIDM."

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Section "SIDM" SecMain
  SetOutPath "$INSTDIR"
  File "${SRC}\host.py"
  File "${SRC}\install.bat"
  File "${SRC}\update.bat"
  File "${SRC}\README.md"
  File /oname=sidm.ico "${ICON}"

  DetailPrint "Downloading the tools and registering SIDM with your browsers..."
!ifdef TEST_SKIP_TOOLS
  StrCpy $0 0 ; scripts/test_setup.py: check the setup steps without downloading anything
!else
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /d /c ""$INSTDIR\install.bat" /quiet"'
  Pop $0
!endif
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "Setup could not finish (code $0). See the messages in the window for the reason.$\r$\n$\r$\nCheck your internet connection, then run Setup again: it continues where it stopped." /SD IDOK
    Abort "Setup did not finish."
  ${EndIf}

  WriteUninstaller "$INSTDIR\uninstall.exe"
  CreateDirectory "$SMPROGRAMS\SIDM"
  CreateShortcut "$SMPROGRAMS\SIDM\Update SIDM tools.lnk" "$INSTDIR\update.bat" "" "$INSTDIR\sidm.ico"
  CreateShortcut "$SMPROGRAMS\SIDM\Uninstall SIDM.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\sidm.ico"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP_LONG}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\sidm.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" 250000
SectionEnd

Section "Uninstall"
  ; The browsers can no longer start the program.
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\${HOST}"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\${HOST}"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\${HOST}"
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\${OLD_HOST}"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\${OLD_HOST}"
  DeleteRegKey HKCU "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\${OLD_HOST}"

  ; Only SIDM's own files, by name. A running download may keep one in use until restart.
  Delete /REBOOTOK "$INSTDIR\yt-dlp.exe"
  Delete /REBOOTOK "$INSTDIR\ffmpeg.exe"
  Delete /REBOOTOK "$INSTDIR\ffprobe.exe"
  Delete "$INSTDIR\host.py"
  Delete "$INSTDIR\host.log"
  Delete "$INSTDIR\install.bat"
  Delete "$INSTDIR\update.bat"
  Delete "$INSTDIR\run_host.bat"
  Delete "$INSTDIR\${HOST}.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\sidm.ico"
  RMDir /r /REBOOTOK "$INSTDIR\python"
  RMDir /r "$INSTDIR\__pycache__"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  Delete "$SMPROGRAMS\SIDM\Update SIDM tools.lnk"
  Delete "$SMPROGRAMS\SIDM\Uninstall SIDM.lnk"
  RMDir "$SMPROGRAMS\SIDM"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
