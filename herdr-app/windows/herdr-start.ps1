# Native Windows client: no Python, Git, WSL, or shared runtime directories.
[CmdletBinding()]
param(
    [switch]$SyncOnly,
    [string]$AppHome = $(if ($env:HERDR_APP_HOME) { $env:HERDR_APP_HOME } else { Join-Path $env:USERPROFILE '.config\herdr-app' }),
    [string]$StateHome = $(Join-Path $env:LOCALAPPDATA 'herdr-profile'),
    [string]$BundleFile
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Test-ProfilePath([string]$Name) {
    if ($Name -match '(^/|\\|:|(^|/)\.)') { return $false }
    return $Name -cmatch '^(keys\.json|settings\.json|programs\.json|(?:layouts|themes)/odysseas[-\w]*\.json|mods/odysseas[-\w]+/[\w./-]+)$'
}
function Get-Hash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return -join ($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString('x2') }) }
    finally { $sha.Dispose() }
}
function Write-Atomic([string]$Path, [byte[]]$Bytes) {
    [IO.Directory]::CreateDirectory((Split-Path $Path)) | Out-Null
    $temp = Join-Path (Split-Path $Path) ('.profile-' + [guid]::NewGuid())
    try {
        [IO.File]::WriteAllBytes($temp, $Bytes)
        if (Test-Path -LiteralPath $Path) {
            $previous = "$temp.previous"
            [IO.File]::Replace($temp, $Path, $previous)
            Remove-Item -LiteralPath $previous
        } else { [IO.File]::Move($temp, $Path) }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp } }
}
function Sync-Profile {
    if ($BundleFile) { $text = [IO.File]::ReadAllText($BundleFile) }
    else {
        $text = (& ssh.exe -n -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5 -o ServerAliveInterval=5 -o ServerAliveCountMax=1 debina 'python3 ~/.dotfiles/herdr-app/profile.py export') -join "`n"
        if ($LASTEXITCODE) { throw "Debina profile fetch failed (SSH exit $LASTEXITCODE)" }
    }
    if ($text.Length -gt 16MB) { throw 'Profile response is too large' }
    $bundle = $text | ConvertFrom-Json
    if ($bundle.schema -ne 1) { throw 'Unsupported profile schema' }
    $files = @{}
    $total = 0
    # Validate everything before writing any preference.
    foreach ($file in $bundle.files) {
        $name = [string]$file.path
        if (-not (Test-ProfilePath $name) -or $files.ContainsKey($name)) { throw "Unsafe or duplicate profile path: $name" }
        $bytes = [Convert]::FromBase64String($file.content)
        $total += $bytes.Length
        if ($total -gt 8MB -or (Get-Hash $bytes) -cne $file.sha256) { throw "Profile checksum/size failure: $name" }
        if ($name.EndsWith('.json')) {
            $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
            if ($null -eq $value -or $value -is [array] -or $value -is [string] -or $value -is [ValueType]) { throw "JSON preference must be an object: $name" }
        }
        $target = Join-Path $AppHome ($name.Replace('/', '\'))
        $parent = $target
        while ($parent -and (Test-Path -LiteralPath $parent)) {
            if ((Get-Item -Force -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Destination is a symlink/reparse point: $parent" }
            $parent = Split-Path $parent
        }
        # Also check existing ancestors when the leaf doesn't exist yet.
        $parent = Split-Path $target
        while ($parent) {
            if ((Test-Path -LiteralPath $parent) -and ((Get-Item -Force -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Destination ancestor is a reparse point: $parent" }
            $parent = Split-Path $parent
        }
        $files[$name] = @{ bytes = $bytes; path = $target; hash = $file.sha256 }
    }
    if (-not $files.ContainsKey('keys.json') -or -not $files.ContainsKey('settings.json')) { throw 'Incomplete profile' }
    $backup = Join-Path $StateHome ('backups\' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss.fffffffZ'))
    $changed = @()
    foreach ($name in ($files.Keys | Sort-Object)) {
        $file = $files[$name]
        if (Test-Path -LiteralPath $file.path) {
            if ((Get-Hash ([IO.File]::ReadAllBytes($file.path))) -ceq $file.hash) { continue }
            $saved = Join-Path $backup $name.Replace('/', '\')
            [IO.Directory]::CreateDirectory((Split-Path $saved)) | Out-Null
            Copy-Item -LiteralPath $file.path -Destination $saved
        }
        Write-Atomic $file.path $file.bytes
        $changed += $name
    }
    $hashes = @{}
    foreach ($name in $files.Keys) { $hashes[$name] = $files[$name].hash }
    $record = @{ synced_at = [DateTime]::UtcNow.ToString('o'); files = $hashes } | ConvertTo-Json -Depth 8
    Write-Atomic (Join-Path $StateHome 'last-sync.json') ([Text.Encoding]::UTF8.GetBytes($record))
    Remove-Item -LiteralPath (Join-Path $StateHome 'sync-error.log') -ErrorAction SilentlyContinue
    return @{ files = $files.Count; changed = $changed } | ConvertTo-Json -Compress
}

try { Sync-Profile }
catch {
    [IO.Directory]::CreateDirectory($StateHome) | Out-Null
    [IO.File]::WriteAllText((Join-Path $StateHome 'sync-error.log'), "$(Get-Date -Format o) $_")
    if ($SyncOnly -or -not (Test-Path (Join-Path $StateHome 'last-sync.json'))) { throw }
    Write-Warning "Profile sync unavailable; using last successful profile. $_"
}
if ($SyncOnly) { return }

# Do not create an elevated SSH core that blocks normal desktop clients.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Launch Herdr (Debina) from the normal desktop, not an Administrator terminal.'
}
$core = Join-Path $env:LOCALAPPDATA 'Programs\herdr-core\herdr-core.exe'
$app = Join-Path $env:LOCALAPPDATA 'Programs\herdr-app\herdr-app.exe'
$machines = (& $core machine ls --json) | ConvertFrom-Json
if ($LASTEXITCODE) { throw 'Could not read core machines' }
if (-not (@($machines.machines) | Where-Object { $_.name -eq 'debina' })) {
    & $core machine add debina --name debina
    if ($LASTEXITCODE) { throw 'Could not connect the Debina core' }
}
Start-Process -FilePath $app -WorkingDirectory $env:USERPROFILE
