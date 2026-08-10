param(
    [string]$Version = "latest",
    [string]$BinDir = "$env:LOCALAPPDATA\Programs\ttyd-pro",
    [switch]$AutoUpdate,
    [switch]$DisableAutoUpdate,
    [switch]$NoModifyPath,
    [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$Repo = if ($env:TTYD_PRO_REPO) { $env:TTYD_PRO_REPO } else { "vannguyen799/ttyd-pro" }

function Write-Log([string]$Message) {
    if (-not $Quiet) { Write-Host $Message }
}

if (-not [Environment]::Is64BitOperatingSystem) {
    throw "ttyd-pro for Windows requires a 64-bit operating system"
}

$Asset = "ttyd-pro-windows-x86_64.exe"
if ($Version -eq "latest") {
    $ReleaseBase = "https://github.com/$Repo/releases/latest/download"
} else {
    if (-not $Version.StartsWith("v")) { $Version = "v$Version" }
    $ReleaseBase = "https://github.com/$Repo/releases/download/$Version"
}

$TempDir = Join-Path ([IO.Path]::GetTempPath()) ("ttyd-pro-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $TempDir | Out-Null
try {
    $AssetPath = Join-Path $TempDir $Asset
    $SumsPath = Join-Path $TempDir "SHA256SUMS"
    Write-Log "Downloading $Asset from GitHub Releases..."
    Invoke-WebRequest -UseBasicParsing "$ReleaseBase/$Asset" -OutFile $AssetPath
    Invoke-WebRequest -UseBasicParsing "$ReleaseBase/SHA256SUMS" -OutFile $SumsPath

    $Pattern = '^([0-9a-fA-F]{64})\s+\*?{0}$' -f [regex]::Escape($Asset)
    $Expected = $null
    foreach ($Line in Get-Content $SumsPath) {
        if ($Line -match $Pattern) { $Expected = $Matches[1]; break }
    }
    if (-not $Expected) { throw "No checksum published for $Asset" }
    $Actual = (Get-FileHash -Algorithm SHA256 $AssetPath).Hash
    if ($Actual -ne $Expected) { throw "SHA-256 verification failed" }

    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $Destination = Join-Path $BinDir "ttyd-pro.exe"
    $InstalledHash = if (Test-Path $Destination) { (Get-FileHash -Algorithm SHA256 $Destination).Hash } else { $null }
    if ($InstalledHash -eq $Expected) {
        Write-Log "ttyd-pro is already up to date in $BinDir."
    } else {
        $NewDestination = "$Destination.new"
        Copy-Item -Force $AssetPath $NewDestination
        Move-Item -Force $NewDestination $Destination
        Write-Log "Installed ttyd-pro to $Destination"
    }
} finally {
    Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
}

if (-not $NoModifyPath) {
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $Entries = @($UserPath -split ";" | Where-Object { $_ })
    if ($Entries -notcontains $BinDir) {
        $NewPath = (($Entries + $BinDir) -join ";")
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
        $env:Path = "$env:Path;$BinDir"
        Write-Log "Added $BinDir to the current user's PATH."
    }
}

$TaskName = "ttyd-pro-update"
$UpdaterDir = Join-Path $env:LOCALAPPDATA "ttyd-pro"
$UpdaterScript = Join-Path $UpdaterDir "install.ps1"

if ($DisableAutoUpdate) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $UpdaterDir -ErrorAction SilentlyContinue
    Write-Log "Disabled ttyd-pro auto-update."
} elseif ($AutoUpdate) {
    New-Item -ItemType Directory -Force -Path $UpdaterDir | Out-Null
    $UpdaterNew = "$UpdaterScript.new"
    $UpdaterSums = Join-Path $UpdaterDir "SHA256SUMS.new"
    Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/latest/download/install.ps1" -OutFile $UpdaterNew
    Invoke-WebRequest -UseBasicParsing "https://github.com/$Repo/releases/latest/download/SHA256SUMS" -OutFile $UpdaterSums
    $UpdaterPattern = '^([0-9a-fA-F]{64})\s+\*?install\.ps1$'
    $UpdaterExpected = $null
    foreach ($Line in Get-Content $UpdaterSums) {
        if ($Line -match $UpdaterPattern) { $UpdaterExpected = $Matches[1]; break }
    }
    if (-not $UpdaterExpected) { throw "No checksum published for the auto-updater" }
    $UpdaterActual = (Get-FileHash -Algorithm SHA256 $UpdaterNew).Hash
    if ($UpdaterActual -ne $UpdaterExpected) { throw "Auto-updater SHA-256 verification failed" }
    Move-Item -Force $UpdaterNew $UpdaterScript
    Remove-Item -Force $UpdaterSums
    $Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$UpdaterScript`" -BinDir `"$BinDir`" -NoModifyPath -Quiet"
    $Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $Arguments
    $Trigger = New-ScheduledTaskTrigger -Daily -At 4am
    $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Description "Update ttyd-pro from GitHub Releases" -Force | Out-Null
    Write-Log "Enabled daily auto-update with the current user's Task Scheduler."
}

Write-Log "Run: ttyd-pro --version"
Write-Log "Re-run this installer at any time to update."
