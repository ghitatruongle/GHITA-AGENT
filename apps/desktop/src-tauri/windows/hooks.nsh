; Ghita Agent NSIS installer hooks.
;
; Tauri derives the NSIS uninstall registry key and the install directory from
; productName. The app shipped as "GHITA CODING AGENT" before the "Ghita Agent"
; rename, so without this hook a renamed installer would install alongside the
; old version instead of replacing it. PREINSTALL removes the legacy install
; (files, shortcuts, registry key) first. User data lives under
; %APPDATA%\com.ghita.coding-agent / %LOCALAPPDATA%\com.ghita.coding-agent
; (identifier-based) and is intentionally left untouched.

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Removing legacy GHITA CODING AGENT install..."

  ; The main binary name comes from the crate name and is unchanged by the
  ; rename, so this also stops the new build if it is somehow running.
  nsExec::Exec 'taskkill /F /T /IM "ghita-coding-agent.exe"'
  Pop $R9
  Sleep 500

  ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GHITA CODING AGENT" "InstallLocation"
  StrCmp $R1 "" legacy_no_dir legacy_have_dir
legacy_no_dir:
  StrCpy $R1 "$LOCALAPPDATA\GHITA CODING AGENT"
legacy_have_dir:
  RMDir /r "$R1"
  Delete "$DESKTOP\GHITA CODING AGENT.lnk"
  Delete "$SMPROGRAMS\GHITA CODING AGENT.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\GHITA CODING AGENT"

  DetailPrint "Legacy install removed."
!macroend
