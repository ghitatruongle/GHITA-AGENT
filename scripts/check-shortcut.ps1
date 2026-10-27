$s = (New-Object -ComObject WScript.Shell).CreateShortcut('C:\Users\Acer\Desktop\Ghita Agent.lnk')
Write-Host 'Target:' $s.TargetPath
Write-Host 'WorkDir:' $s.WorkingDirectory
Write-Host 'Icon:' $s.IconLocation

# Check exe version
$exePath = $s.TargetPath
if (Test-Path $exePath) {
    $ver = (Get-Item $exePath).VersionInfo
    Write-Host 'Exe version:' $ver.FileVersion
    Write-Host 'Product version:' $ver.ProductVersion
}
