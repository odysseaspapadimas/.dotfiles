# Native Windows sync tests; no app/core startup and no real preferences touched.
[CmdletBinding()]
param([string]$SyncScript = "$env:LOCALAPPDATA\Programs\herdr-profile\herdr-start.ps1")
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('herdr-profile-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force $root | Out-Null
try {
    $text = (& ssh.exe -n -o BatchMode=yes -o StrictHostKeyChecking=yes debina 'python3 ~/.dotfiles/herdr-app/profile.py export') -join "`n"
    if ($LASTEXITCODE) { throw 'SSH export failed' }
    $bundle = Join-Path $root 'bundle.json'
    [IO.File]::WriteAllText($bundle, $text)
    $homePath = Join-Path $root 'app'
    $state = Join-Path $root 'state'
    $first = & $SyncScript -SyncOnly -AppHome $homePath -StateHome $state -BundleFile $bundle | ConvertFrom-Json
    if ($first.changed.Count -lt 2) { throw 'Initial sync did not deploy files' }
    [IO.File]::WriteAllText((Join-Path $homePath 'view.json'), '{"focus":"keep-local"}')
    $second = & $SyncScript -SyncOnly -AppHome $homePath -StateHome $state -BundleFile $bundle | ConvertFrom-Json
    if ($second.changed.Count -ne 0) { throw 'Sync is not idempotent' }
    if ([IO.File]::ReadAllText((Join-Path $homePath 'view.json')) -ne '{"focus":"keep-local"}') { throw 'Runtime state changed' }
    [IO.File]::WriteAllText((Join-Path $homePath 'settings.json'), '{"zoom":2}')
    & $SyncScript -SyncOnly -AppHome $homePath -StateHome $state -BundleFile $bundle | Out-Null
    $backups = @(Get-ChildItem (Join-Path $state 'backups') -Filter settings.json -Recurse)
    if ($backups.Count -ne 1 -or [IO.File]::ReadAllText($backups[0].FullName) -ne '{"zoom":2}') { throw 'Previous settings not backed up' }
    foreach ($mutation in @('path','checksum','duplicate')) {
        $bad = $text | ConvertFrom-Json
        if ($mutation -eq 'path') { $bad.files[0].path = '../keys.json' }
        if ($mutation -eq 'checksum') { $bad.files[0].sha256 = '0000' }
        if ($mutation -eq 'duplicate') { $bad.files += $bad.files[0] }
        [IO.File]::WriteAllText($bundle, ($bad | ConvertTo-Json -Depth 10))
        $rejected = $false
        try { & $SyncScript -SyncOnly -AppHome (Join-Path $root "bad-$mutation") -StateHome (Join-Path $root "bad-state-$mutation") -BundleFile $bundle | Out-Null }
        catch { $rejected = $true }
        if (-not $rejected -or (Test-Path (Join-Path $root "bad-$mutation\keys.json"))) { throw "Bad $mutation profile was not rejected atomically" }
    }
    Write-Output 'Windows profile tests: PASS (deploy, idempotence, runtime preservation, backup, traversal/checksum/duplicate rejection)'
} finally { Remove-Item -Recurse -Force $root }
