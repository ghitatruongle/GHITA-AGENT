$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Ghita Agent'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$sourceExe = 'D:\Ghita Agent\apps\desktop\src-tauri\target\release\ghita-coding-agent.exe'
Copy-Item -Path $sourceExe -Destination $installDir -Force

# Copy all release files
$sourceDir = 'D:\Ghita Agent\apps\desktop\src-tauri\target\release'
if (Test-Path $sourceDir) {
    Get-ChildItem -Path $sourceDir -File | Copy-Item -Destination $installDir -Force
}

Write-Host 'Files copied to:' $installDir

# Create desktop shortcut
$desktopPath = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktopPath 'Ghita Agent.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $installDir 'ghita-coding-agent.exe'
$shortcut.WorkingDirectory = $installDir
$shortcut.IconLocation = Join-Path $installDir 'ghita-coding-agent.exe'
$shortcut.Save()
Write-Host 'Shortcut created at:' $shortcutPath
