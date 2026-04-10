; ========================================================================
; Nebula custom NSIS installer script
; Runs cleanup of orphaned files from previous versions before install
; ========================================================================

!macro customInit
  ; Kill any running Nebula processes so we can delete their files
  nsExec::Exec 'taskkill /F /IM "Nebula.exe" /T'
  nsExec::Exec 'taskkill /F /IM "Riot Client.exe" /T'
  nsExec::Exec 'taskkill /F /IM RiotClientServices.exe /T'
  Sleep 500

  ; --- Delete orphaned AppData from previous versions ---
  ; Current user install (v3+)
  RMDir /r "$APPDATA\nebula"
  RMDir /r "$APPDATA\Nebula"
  RMDir /r "$LOCALAPPDATA\nebula"
  RMDir /r "$LOCALAPPDATA\Nebula"

  ; --- Delete orphaned program files from previous installs ---
  ; v2 era install locations
  RMDir /r "$LOCALAPPDATA\Programs\nebula"
  RMDir /r "$LOCALAPPDATA\Programs\Nebula"
  RMDir /r "$PROGRAMFILES\Nebula"
  RMDir /r "$PROGRAMFILES64\Nebula"

  ; --- Remove stale Windows Credential Manager entries from keytar (v2 era) ---
  ; v2 used keytar with service name "NebulaAccountManager" and "NebulaStoreKey"
  nsExec::Exec 'cmdkey /delete:NebulaAccountManager'
  nsExec::Exec 'cmdkey /delete:NebulaStoreKey'

  ; --- Remove stale shortcut from older versions (may have had different names) ---
  Delete "$DESKTOP\Nebula.lnk"
  Delete "$SMPROGRAMS\Nebula.lnk"
  Delete "$SMPROGRAMS\Nebula\Nebula.lnk"
  RMDir "$SMPROGRAMS\Nebula"
!macroend

!macro customUnInit
  ; Kill any running instances before uninstall
  nsExec::Exec 'taskkill /F /IM "Nebula.exe" /T'
  Sleep 500
!macroend

!macro customUnInstall
  ; Extra cleanup on uninstall in case electron-builder's deleteAppDataOnUninstall misses anything
  RMDir /r "$APPDATA\nebula"
  RMDir /r "$LOCALAPPDATA\nebula"

  ; Remove any leftover credential entries
  nsExec::Exec 'cmdkey /delete:NebulaAccountManager'
  nsExec::Exec 'cmdkey /delete:NebulaStoreKey'
!macroend
