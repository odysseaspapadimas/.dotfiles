# Run from a normal desktop PowerShell after configuring SSH Host debina.
[CmdletBinding()]
param([switch]$Launch)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$app = Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
if (-not (Test-Path $app)) {
    $installer = Join-Path $env:TEMP 'herdr-app-install.ps1'
    Invoke-WebRequest -UseBasicParsing https://releases.herdr.dev/app/install.ps1 -OutFile $installer
    & $installer
}
$program = Join-Path $env:LOCALAPPDATA 'Programs\herdr-profile'
New-Item -ItemType Directory -Force $program | Out-Null
Copy-Item -LiteralPath "$PSScriptRoot\herdr-start.ps1" -Destination "$program\herdr-start.ps1" -Force
& "$program\herdr-start.ps1" -SyncOnly
[IO.File]::WriteAllText("$program\herdr-start.cmd", "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"%~dp0herdr-start.ps1`" %*`r`n", [Text.Encoding]::ASCII)
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Herdr (Debina).lnk'
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($menu)
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$program\herdr-start.ps1`""
$link.WorkingDirectory = $env:USERPROFILE
$link.IconLocation = "$app,0"
$link.Description = 'Synced Ctrl+Space profile; agents and terminals on Debina'
$link.Save()
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if (-not ($raw -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $program.TrimEnd('\') })) {
        $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
        $key.SetValue('Path', $(if ($raw) { "$($raw.TrimEnd(';'));$program" } else { $program }), $kind)
    }
} finally { $key.Close() }
# Seed the initial view without a UTF-8 BOM; future syncs leave it alone.
$shared = Join-Path $env:USERPROFILE '.config\herdr-app\shared.json'
if (-not (Test-Path $shared)) {
    [IO.File]::WriteAllText($shared, '{"layout":"odysseas","frame.welcomed":"finished","workspace.panels":["files","changes"]}', (New-Object Text.UTF8Encoding($false)))
}
Write-Output "Installed $menu (open a new terminal for herdr-start)."
if ($Launch) { & "$program\herdr-start.ps1" }
