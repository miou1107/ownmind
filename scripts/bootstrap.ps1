# OwnMind Universal Bootstrap for Windows PowerShell
#
# Usage:
#   Already installed (upgrade only):
#     powershell -ExecutionPolicy Bypass -File $HOME\.ownmind\scripts\bootstrap.ps1
#     iwr -useb https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.ps1 | iex
#   Fresh install / repair (needs API key + URL via args or env):
#     $env:OWNMIND_API_KEY='xxx'; $env:OWNMIND_API_URL='https://your-server.com/ownmind'
#     iwr -useb https://raw.githubusercontent.com/miou1107/ownmind/main/scripts/bootstrap.ps1 | iex
#
# Branches:
#   1. ~/.ownmind not present         -> fresh clone (git) or release archive (no git), then install.ps1
#   2. ~/.ownmind present, no .git    -> with .release: healthy archive install, re-run install.ps1
#                                        without .release: backup + re-install (needs API key args/env)
#   3. ~/.ownmind is a git repo       -> delegate to scripts/interactive-upgrade.ps1 (no args needed)
#
# Archive mode (no git on this machine): the release archive comes from the OwnMind server
# ($API_URL/api/install/archive?format=zip), then from GitHub. It is unpacked into
# ~/.ownmind.partial and moved to ~/.ownmind only after a full unpack.
#
# Env overrides (for testing):
#   $env:OWNMIND_DIR              - install path (default: $env:USERPROFILE\.ownmind)
#   $env:OWNMIND_REPO             - git URL      (default: https://github.com/miou1107/ownmind.git)
#   $env:OWNMIND_SOURCE           - server | github: force one archive source (default: server, then github)
#   $env:OWNMIND_GITHUB_API       - GitHub API base URL (default: https://api.github.com)
#   $env:OWNMIND_GITHUB_CODELOAD  - GitHub site base URL for /<repo>/archive/... (default: https://github.com)
#
# Log format (machine-readable):
#   "INFO:detect:<message>"   - progress message
#   "OK:done:<message>"       - step succeeded
#   "ERROR:install:<message>" - failure
#   "FIX:<code>:<command>"    - a command that repairs the failure
#   "ASK:<code>:<sentence>"   - something the person at the keyboard has to do

$ErrorActionPreference = "Stop"

# Normalise the environment (v1.17.9, reported by Bob): Git Bash / MSYS overwrites $HOME with /c/Users/xxx
if ($env:USERPROFILE -and ($HOME -ne $env:USERPROFILE)) {
  Set-Variable -Name HOME -Value $env:USERPROFILE -Force -Scope Global -ErrorAction SilentlyContinue
}

$OwnmindDir = if ($env:OWNMIND_DIR) { $env:OWNMIND_DIR } else { "$env:USERPROFILE\.ownmind" }
$Repo = if ($env:OWNMIND_REPO) { $env:OWNMIND_REPO } else { "https://github.com/miou1107/ownmind.git" }
$Ts = Get-Date -Format "yyyyMMdd-HHmmss"

function Log-Info($code, $msg) { Write-Host "INFO:${code}:${msg}" }
function Log-Ok($code, $msg)   { Write-Host "OK:${code}:${msg}" }
function Log-Err($code, $msg)  { Write-Host "ERROR:${code}:${msg}" -ForegroundColor Red }

# install.ps1 writes its NEXT line to this file as well as printing it (OWNMIND_NEXT_FILE), and
# this script prints it again as the very last line of a successful run, so the AI that reads the
# output reads the instruction last. The file holds the line as printed (the person's language)
# and, on a second line, the English version for a console that cannot be switched to UTF-8.
$env:OWNMIND_NEXT_FILE = Join-Path ([System.IO.Path]::GetTempPath()) "ownmind-next.$PID"
Remove-Item -LiteralPath $env:OWNMIND_NEXT_FILE -Force -ErrorAction SilentlyContinue
function Write-OwnMindNext {
  $file = $env:OWNMIND_NEXT_FILE
  if (-not $file) { return }
  try {
    if (Test-Path -LiteralPath $file) {
      $lines = @([System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding $false)) -split "`r?`n" | Where-Object { $_ })
      if ($lines.Count -gt 0) {
        $text = $lines[0]
        $previous = $null
        try {
          $previous = [Console]::OutputEncoding
          [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
        } catch {
          $previous = $null
          if ($lines.Count -gt 1) { $text = $lines[1] }
        }
        try { Write-Host $text } finally {
          if ($previous) { try { [Console]::OutputEncoding = $previous } catch { } }
        }
      }
    }
  } catch { }
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
}
# The server address the FIX lines name; the arguments are KEY URL, or the environment variables.
$global:OwnMindFixApi = ''
$positionalForFix = @($args | Where-Object { $_ -and ("$_" -notlike '-*') })
if ($positionalForFix.Count -ge 2) { $global:OwnMindFixApi = "$($positionalForFix[1])".TrimEnd('/') }
elseif ($env:OWNMIND_API_URL) { $global:OwnMindFixApi = $env:OWNMIND_API_URL.TrimEnd('/') }

# Without git, OwnMind is installed from a release archive (see "Archive mode" above). The
# download and unpack functions below are an embedded copy of
# scripts/install-helpers/fetch-release.ps1: this script is fetched over the network and run
# before anything is on disk, so it cannot dot-source that file.
# tests/bootstrap-archive-mode-ps1.test.js fails when the two copies differ.
# BEGIN fetch-release
# Windows PowerShell 5.1 on a stock Windows 10 offers TLS 1.0 and 1.1 unless told otherwise, and
# GitHub and nodejs.org refuse both. Adding TLS 1.2 changes nothing on a machine that has it.
function Enable-OwnMindTls12 {
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
}

# Write-OwnMindLocalized -Prefix TEXT -Command @('ask', CODE) -Literal TEXT
# Prints Prefix + a sentence in the person's own language (the Windows UI language picks it) when
# this computer already has a node and the OwnMind checkout's install-messages.cjs; otherwise
# (bootstrap runs before any node is on the machine) Prefix + the English Literal. The sentence is
# printed while the console is still switched to UTF-8: the same text printed after the old code
# page is back would reach the AI as garbage. When the console cannot be switched, the English
# literal is printed instead. Returns the line it printed. The literal must equal
# hooks/locales/en.json: tests/install-messages.test.js checks that.
function Write-OwnMindLocalized {
  param(
    [string]$Prefix = '',
    [Parameter(Mandatory = $true)][string[]]$Command,
    [Parameter(Mandatory = $true)][string]$Literal
  )
  $text = ''
  try {
    $dir = Join-Path $env:USERPROFILE '.ownmind'
    if ($env:OWNMIND_DIR) { $dir = $env:OWNMIND_DIR }
    $helper = Join-Path $dir 'scripts\install-helpers\install-messages.cjs'
    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
    if ($node -and (Test-Path -LiteralPath $helper)) {
      $argv = @($helper) + $Command
      if (-not $env:OWNMIND_LOCALE_FORCE) { $argv += @('--locale', (Get-UICulture).Name) }
      $exe = [string]@($node)[0].Source
      $previous = [Console]::OutputEncoding
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      try {
        $out = & $exe @argv 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) {
          $text = $Prefix + ("$out").Trim()
          Write-Host $text
        }
      } finally {
        [Console]::OutputEncoding = $previous
      }
    }
  } catch { }
  if (-not $text) {
    $text = $Prefix + $Literal
    Write-Host $text
  }
  return $text
}

# Write-OwnMindAsk -Code CODE -Literal "ASK:CODE:<English sentence>"
function Write-OwnMindAsk {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Literal
  )
  Write-OwnMindLocalized -Command @('ask', $Code) -Literal $Literal | Out-Null
}

# The PowerShell command that runs the installer again: the server's own install.ps1, with the
# server address when it is known ($global:OwnMindFixApi) and the key left as <KEY> for the AI to
# fill in from the install message. -Source github or clear adds the OWNMIND_SOURCE setting that
# is the fix; clear-node resets OWNMIND_NODE_SOURCE.
function Get-OwnMindRetryCommand {
  param([string]$Source = '')
  $api = '<API_URL>'
  $known = Get-Variable -Name OwnMindFixApi -Scope Global -ErrorAction SilentlyContinue
  if ($known -and $known.Value) { $api = [string]$known.Value }
  $set = ''
  if ($Source -eq 'github') { $set = '$env:OWNMIND_SOURCE=''github''; ' }
  elseif ($Source -eq 'clear') { $set = '$env:OWNMIND_SOURCE=''''; ' }
  elseif ($Source -eq 'clear-node') { $set = '$env:OWNMIND_NODE_SOURCE=''''; ' }
  return ($set + '$env:OWNMIND_API_KEY=''<KEY>''; $env:OWNMIND_API_URL=''' + $api + '''; irm ' + $api + '/install.ps1 | iex')
}

# Whether an error from a download or an unpack says the disk is full (Windows error 112,
# or 39 when a handle ran out of room).
function Test-OwnMindDiskFull {
  param($ErrorRecord)
  $ex = $null
  if ($ErrorRecord) { $ex = $ErrorRecord.Exception }
  while ($ex) {
    $code = $ex.HResult -band 0xFFFF
    if ($code -eq 112 -or $code -eq 39) { return $true }
    if ("$($ex.Message)" -match 'not enough space on the disk|disk is full|No space left') { return $true }
    $ex = $ex.InnerException
  }
  return $false
}

# Move-OwnMindItemRetry -Path FROM -Destination TO
# Antivirus often holds a freshly unpacked file (node.exe above all) for a few seconds while it
# scans it, so the rename fails with access denied and then succeeds. Up to five tries, two seconds
# apart; a full disk does not get better by waiting, so that error is thrown at once.
function Move-OwnMindItemRetry {
  param([string]$Path, [string]$Destination)
  for ($try = 1; $try -le 5; $try++) {
    try {
      Move-Item -LiteralPath $Path -Destination $Destination -ErrorAction Stop
      return
    } catch {
      if ($try -eq 5 -or (Test-OwnMindDiskFull $_)) { throw }
      Start-Sleep -Seconds 2
    }
  }
}

# Write-OwnMindStopWrite -Code CODE -Message TEXT -ErrorRecord $_
# A step that writes to disk failed. A full disk is something only the person can fix (ASK);
# anything else is worth one more run (FIX).
function Write-OwnMindStopWrite {
  param(
    [Parameter(Mandatory = $true)][string]$Code,
    [Parameter(Mandatory = $true)][string]$Message,
    $ErrorRecord = $null
  )
  if (Test-OwnMindDiskFull $ErrorRecord) {
    Log-Err $Code "$Message (the disk is full)"
    Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
  } else {
    Log-Err $Code $Message
    Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
  }
}

# Invoke-OwnMindDownload -Uri URL -Dest FILE [-Headers @{...}]
# Three tries with a short wait between them. Returns the web response (its Headers are what the
# Node download reads) or $null when every try failed; the file is gone after a failure.
# The progress bar is switched off because Windows PowerShell 5.1 draws it so slowly that a 30 MB
# download takes minutes with it and seconds without.
function Invoke-OwnMindDownload {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Dest,
    [hashtable]$Headers = @{}
  )
  Set-StrictMode -Version Latest
  Enable-OwnMindTls12
  $ProgressPreference = 'SilentlyContinue'
  $dir = Split-Path -Parent $Dest
  if ($dir -and -not (Test-Path -LiteralPath $dir)) {
    try {
      New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
    } catch {
      if (Test-OwnMindDiskFull $_) { $global:OwnMindDiskFull = $true }
      return $null
    }
  }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $resp = Invoke-WebRequest -Uri $Uri -OutFile $Dest -Headers $Headers -UseBasicParsing -TimeoutSec 120 -PassThru -ErrorAction Stop
      return $resp
    } catch {
      Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
      # A full disk will not get better in two seconds; stop trying and say so.
      if (Test-OwnMindDiskFull $_) { $global:OwnMindDiskFull = $true; return $null }
      if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
    }
  }
  return $null
}

# One response header as trimmed text, or an empty string. Windows PowerShell 5.1 hands back a
# string, PowerShell 7 an array of strings; both end up as one string.
function Get-OwnMindHeader {
  param($Response, [string]$Name)
  Set-StrictMode -Version Latest
  try { $value = $Response.Headers[$Name] } catch { return '' }
  if ($null -eq $value) { return '' }
  if ($value -is [array]) { $value = $value[0] }
  return ([string]$value).Trim()
}

# Newest vX.Y.Z tag of the public repo, read from the GitHub API with a regular expression
# (nothing here depends on node). Returns an empty string when the tags API cannot be reached.
function Get-OwnMindGithubLatestTag {
  Set-StrictMode -Version Latest
  Enable-OwnMindTls12
  $ProgressPreference = 'SilentlyContinue'
  $apiBase = 'https://api.github.com'
  if ($env:OWNMIND_GITHUB_API) { $apiBase = $env:OWNMIND_GITHUB_API.TrimEnd('/') }
  $text = ''
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      $r = Invoke-WebRequest -Uri "$apiBase/repos/miou1107/ownmind/tags?per_page=30" -UseBasicParsing -TimeoutSec 30 -ErrorAction Stop
      $text = [string]$r.Content
      break
    } catch {
      if ($attempt -lt 3) { Start-Sleep -Seconds $attempt }
    }
  }
  if (-not $text) { return '' }
  $best = $null
  $bestName = ''
  foreach ($m in [regex]::Matches($text, '"name"\s*:\s*"(v(\d+\.\d+\.\d+))"')) {
    try { $v = [version]$m.Groups[2].Value } catch { continue }
    if ($null -eq $best -or $v -gt $best) { $best = $v; $bestName = $m.Groups[1].Value }
  }
  return $bestName
}

# Get-OwnMindArchive -Key KEY -Api API_URL -Dest FILE
# Sources in order: the OwnMind server, then GitHub. OWNMIND_SOURCE=server|github forces one.
# Returns @{ Strip = <bool>; Release = <text> } on success: Strip is true when the archive has one
# top-level folder to strip, and Release is the name to write into .release in that case.
# Returns $null on failure, after printing the ERROR / FIX / ASK lines.
function Get-OwnMindArchive {
  param(
    [string]$Key,
    [string]$Api,
    [Parameter(Mandatory = $true)][string]$Dest
  )
  Set-StrictMode -Version Latest
  $global:OwnMindDiskFull = $false
  $api = ''
  if ($Api) { $api = $Api.TrimEnd('/') }
  $global:OwnMindFixApi = $api
  $source = ''
  if ($env:OWNMIND_SOURCE) { $source = $env:OWNMIND_SOURCE }
  $ghBase = 'https://github.com'
  if ($env:OWNMIND_GITHUB_CODELOAD) { $ghBase = $env:OWNMIND_GITHUB_CODELOAD.TrimEnd('/') }
  $result = @{ Strip = $false; Release = '' }

  if ($source -ne '' -and $source -ne 'server' -and $source -ne 'github') {
    Log-Err download "OWNMIND_SOURCE must be server or github (got: $source)"
    Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand -Source clear)"
    return $null
  }

  if ($source -ne 'github') {
    Log-Info download "Downloading the release archive from $api"
    if ($Key -and $api) {
      $resp = Invoke-OwnMindDownload -Uri "$api/api/install/archive?format=zip" -Dest $Dest -Headers @{ Authorization = "Bearer $Key" }
      if ($null -ne $resp) { return $result }
    }
    Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    if ($global:OwnMindDiskFull) {
      Log-Err download "Could not save the release archive (the disk is full)"
      Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
      return $null
    }
    if ($source -eq 'server') {
      Log-Err download "Could not download the release archive from $api"
      Write-Host "FIX:use_fallback_source:$(Get-OwnMindRetryCommand -Source github)"
      Write-OwnMindAsk -Code no_network -Literal "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
      return $null
    }
    Log-Info fallback_source "The OwnMind server did not deliver the archive; trying GitHub"
  }

  $tag = Get-OwnMindGithubLatestTag
  if ($tag) {
    $ref = "refs/tags/$tag"
    $release = $tag
  } else {
    $ref = 'refs/heads/main'
    $release = 'main'
    Log-Info fallback_source "GitHub tag list unavailable; using the main branch"
  }
  Log-Info download "Downloading the release archive from GitHub ($release)"
  $resp = Invoke-OwnMindDownload -Uri "$ghBase/miou1107/ownmind/archive/$ref.zip" -Dest $Dest
  if ($null -ne $resp) {
    $result.Strip = $true
    $result.Release = $release
    return $result
  }
  Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  if ($global:OwnMindDiskFull) {
    Log-Err download "Could not save the release archive (the disk is full)"
    Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
    return $null
  }
  Log-Err download "Could not download the release archive from the OwnMind server or GitHub"
  Write-OwnMindAsk -Code no_network -Literal "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
  return $null
}

# Expand-OwnMindRelease -Archive ZIP -Partial DIR -Final DIR -Strip <bool> -Release TEXT
# Unpacks into PARTIAL\unpack, checks that .release and install.ps1 are there, and only then
# moves the folder to FINAL and removes PARTIAL, so FINAL never exists half-unpacked.
# Returns $true or $false (after printing an ERROR line).
function Expand-OwnMindRelease {
  param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Partial,
    [Parameter(Mandatory = $true)][string]$Final,
    [bool]$Strip = $false,
    [string]$Release = ''
  )
  Set-StrictMode -Version Latest
  # Windows PowerShell 5.1 redraws a progress bar for every entry of the zip, and that drawing is
  # most of the unpack time; with it off the same unpack takes seconds.
  $ProgressPreference = 'SilentlyContinue'
  $unpack = Join-Path $Partial 'unpack'
  try {
    New-Item -ItemType Directory -Force -Path $unpack | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $unpack -Force -ErrorAction Stop
  } catch {
    if (Test-OwnMindDiskFull $_) {
      Log-Err unpack "Could not unpack the archive (the disk is full)"
      Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
    } else {
      Log-Err unpack "Could not unpack the archive (it may be damaged)"
      Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
    }
    return $false
  }
  $root = $unpack
  if ($Strip) {
    # GitHub archives wrap everything in one folder, and carry no .release of their own.
    $all = @(Get-ChildItem -LiteralPath $unpack -Force)
    if ($all.Count -ne 1 -or -not $all[0].PSIsContainer) {
      Log-Err unpack "The GitHub archive does not have the one top-level folder that was expected"
      Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
      return $false
    }
    $root = $all[0].FullName
    [System.IO.File]::WriteAllText((Join-Path $root '.release'), "$Release`n", (New-Object System.Text.UTF8Encoding $false))
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root '.release') -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $root 'install.ps1') -PathType Leaf)) {
    Log-Err unpack "The archive is missing .release or install.ps1"
    Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
    return $false
  }
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue
  $parent = Split-Path -Parent $Final
  try {
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop | Out-Null
    }
    Move-OwnMindItemRetry -Path $root -Destination $Final
  } catch {
    Write-OwnMindStopWrite -Code unpack -Message "Could not move the unpacked files into $Final" -ErrorRecord $_
    return $false
  }
  Remove-Item -LiteralPath $Partial -Recurse -Force -ErrorAction SilentlyContinue
  $name = "$(Get-Content -LiteralPath (Join-Path $Final '.release') -TotalCount 1 -Encoding UTF8)".Trim()
  Log-Ok unpack "release $name unpacked"
  return $true
}
# END fetch-release

# -CommandType Application on purpose: a profile alias named git is not a program these scripts
# can invoke, and it would read as present here and fail later.
$gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue
$HasGit = ($null -ne $gitCmd)

# Download the archive and unpack it into $OwnmindDir. Used whenever there is no git, or the
# directory has to be rebuilt without git. Exits the script on failure.
function Install-FromArchive {
  param([object[]]$ArgList)
  # The same two inputs install.ps1 takes: positional KEY URL, or the OWNMIND_API_KEY and
  # OWNMIND_API_URL variables. Flag-like arguments are not a key.
  $positional = @($ArgList | Where-Object { $_ -and ("$_" -notlike '-*') })
  $key = ''
  $api = ''
  if ($positional.Count -ge 1) { $key = "$($positional[0])" }
  elseif ($env:OWNMIND_API_KEY) { $key = $env:OWNMIND_API_KEY }
  elseif ($env:OWNMIND_INSTALL_KEY) { $key = $env:OWNMIND_INSTALL_KEY }
  if ($positional.Count -ge 2) { $api = "$($positional[1])" }
  elseif ($env:OWNMIND_API_URL) { $api = $env:OWNMIND_API_URL }
  if (-not $key -or -not $api) {
    Log-Err missing_args "The API key and URL are needed to install OwnMind (powershell -ExecutionPolicy Bypass -File bootstrap.ps1 YOUR_API_KEY YOUR_API_URL)"
    Write-Host "FIX:rerun_with_args:`$env:OWNMIND_API_KEY='<KEY>'; `$env:OWNMIND_API_URL='<API_URL>'; irm <API_URL>/install.ps1 | iex"
    exit 1
  }
  $partial = "$OwnmindDir.partial"
  Log-Info archive_mode "git is not installed; installing from the release archive"
  if (Test-Path -LiteralPath $partial) {
    Log-Info clear_partial "Removing the unfinished download from an earlier attempt ($partial)"
    try {
      Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction Stop
    } catch {
      Log-Err clear_partial "Could not remove $partial"
      Write-Host 'FIX:clear_partial:Remove-Item -Recurse -Force "$env:USERPROFILE\.ownmind.partial"'
      exit 1
    }
  }
  # grammar-allow: Get-OwnMindArchive and Expand-OwnMindRelease have already printed their own ERROR with FIX or ASK
  $dl = @(Get-OwnMindArchive -Key $key -Api $api -Dest (Join-Path $partial 'archive.zip')) | Select-Object -Last 1
  if ($null -eq $dl) {
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    exit 1
  }
  # grammar-allow: Expand-OwnMindRelease has already printed its own ERROR with FIX or ASK
  $unpacked = @(Expand-OwnMindRelease -Archive (Join-Path $partial 'archive.zip') -Partial $partial -Final $OwnmindDir -Strip ([bool]$dl.Strip) -Release ([string]$dl.Release)) | Select-Object -Last 1
  if (-not $unpacked) { exit 1 }
  Set-Location "$OwnmindDir"
  # Private Node runtime when this machine has no usable node. The file exists in every release
  # that has this feature; the guard lets an older release without it still install.
  # grammar-allow: Ensure-OwnMindNode has already printed its own ERROR with FIX or ASK
  $nodeHelper = Join-Path $OwnmindDir 'scripts\install-helpers\ensure-node-runtime.ps1'
  if (Test-Path -LiteralPath $nodeHelper) {
    . $nodeHelper
    $nodeOk = @(Ensure-OwnMindNode -ApiUrl $api.TrimEnd('/') -ApiKey $key) | Select-Object -Last 1
    if (-not $nodeOk) { exit 1 }
  }
  Log-Info install "Running install.ps1 (forwarding API_KEY / API_URL)"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @ArgList
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 failed (missing API_KEY/URL or other error)"; Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"; exit 1 }
  Log-Ok done "Fresh install complete (release archive)"
}

Log-Info detect "Checking OwnMind installation ($OwnmindDir)"

# Forward positional args (if any) to install.ps1; install.ps1 falls back to
# $env:OWNMIND_API_KEY / $env:OWNMIND_API_URL when args are empty (see its own
# arg handling). This lets both `bootstrap.ps1 KEY URL` and
# `$env:OWNMIND_API_KEY=... iwr | iex` patterns work.
$InstallArgs = $args

# True when this run carries the key and URL (the install message: positional KEY URL, or the two
# variables it sets). The no-argument run is the upgrade the ownmind-upgrade skill starts.
$positionalArgs = @($InstallArgs | Where-Object { $_ -and ("$_" -notlike '-*') })
$HasInstallArgs = ($positionalArgs.Count -ge 2) -or (($env:OWNMIND_API_KEY -or $env:OWNMIND_INSTALL_KEY) -and $env:OWNMIND_API_URL)

# Branch 1: no install
if (-not (Test-Path "$OwnmindDir")) {
  if (-not $HasGit) {
    Install-FromArchive $InstallArgs
    Write-OwnMindNext
    exit 0
  }
  Log-Info fresh "Fresh install: cloning repo"
  git clone "$Repo" "$OwnmindDir"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$OwnmindDir\.git")) {
    Log-Err git_clone "git clone failed (check network or GitHub access)"
    Write-OwnMindAsk -Code no_network -Literal "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
    exit 1
  }
  Log-Ok clone "Clone complete"
  Set-Location "$OwnmindDir"
  Log-Info install "Running install.ps1 (forwarding API_KEY / API_URL)"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 failed (missing API_KEY/URL or other error)"; Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"; exit 1 }
  Log-Ok done "Fresh install complete"
  Write-OwnMindNext
  exit 0
}

# Branch 2: no .git. With .release and install.ps1 this is a healthy archive install; otherwise it is broken.
# A swap journal without .release is an archive update stopped part-way, not a broken directory.
if (-not (Test-Path "$OwnmindDir\.git") -and ((Test-Path -LiteralPath "$OwnmindDir\.release") -or (Test-Path -LiteralPath "$OwnmindDir\.swap-journal.json")) -and (Test-Path -LiteralPath "$OwnmindDir\install.ps1")) {
  $upgrader = "$OwnmindDir\scripts\interactive-upgrade.ps1"
  # The upgrader's archive branch is marked with this literal. A run that carries the key and URL
  # is the install message pasted again, usually after a FIX or ASK stopped the first install
  # part-way (no Node yet, no credentials written, npm failed). The upgrader cannot finish that: it
  # reads the credentials from settings and never installs Node; install.ps1 does both.
  if ((-not $HasInstallArgs) -and (Test-Path -LiteralPath $upgrader) -and (Select-String -LiteralPath $upgrader -Pattern 'ARCHIVE_MODE' -SimpleMatch -Quiet)) {
    Log-Info upgrade "Archive install found; delegating to interactive-upgrade.ps1"
    & powershell -ExecutionPolicy Bypass -File $upgrader
    exit $LASTEXITCODE
  }
  Log-Info already_installed "archive install found; re-running install.ps1"
  Set-Location "$OwnmindDir"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 failed (missing API_KEY/URL or other error)"; Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"; exit 1 }
  Log-Ok done "Archive install checked"
  Write-OwnMindNext
  exit 0
}

# Branch 2b: broken
if (-not (Test-Path "$OwnmindDir\.git")) {
  $Bak = "$OwnmindDir.broken.$Ts"
  Log-Info broken "$OwnmindDir exists but is not a git repo; backing up to $Bak"
  # A rename within the same folder: runtime\current (a directory junction) moves as a link and
  # is not followed. The rename keeps the old modification time, so it is reset for the 7-day
  # sweep in interactive-upgrade.ps1.
  Move-Item "$OwnmindDir" "$Bak"
  try { (Get-Item -LiteralPath $Bak -Force -ErrorAction Stop).LastWriteTime = Get-Date } catch { }
  Log-Ok backup "Backed up"
  if (-not $HasGit) {
    Install-FromArchive $InstallArgs
    Log-Ok done "Repair complete (old data preserved at $Bak; backups older than 7 days are swept on next upgrade)"
    Write-OwnMindNext
    exit 0
  }
  Log-Info fresh "Re-cloning"
  git clone "$Repo" "$OwnmindDir"
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path "$OwnmindDir\.git")) {
    Log-Err git_clone "Re-clone failed; old data preserved at $Bak"
    Write-OwnMindAsk -Code no_network -Literal "ASK:no_network:The installer could not reach the OwnMind server or GitHub. Check that this computer is online, then paste the same install message to the AI again."
    exit 1
  }
  Set-Location "$OwnmindDir"
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 failed (missing API_KEY/URL or other error)"; Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"; exit 1 }
  Log-Ok done "Repair complete (old data preserved at $Bak; backups older than 7 days are swept on next upgrade)"
  Write-OwnMindNext
  exit 0
}

# Branch 3 with the key and URL: the install message pasted on a machine that already has a git
# checkout (a first install that stopped after the clone, or a reinstall). The upgrader would skip
# install.ps1 when no credentials were written yet, so the checkout is brought up to date when it
# can be (a fast-forward only; local changes are left alone) and install.ps1 runs with the arguments.
if ($HasInstallArgs) {
  Log-Info reinstall "Installed (git); re-running install.ps1 with the key and URL"
  Set-Location "$OwnmindDir"
  if ($HasGit) {
    & git pull --ff-only --quiet 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { Log-Info reinstall "Could not fast-forward the checkout; installing the code that is here" }
  }
  & powershell -ExecutionPolicy Bypass -File .\install.ps1 @InstallArgs
  if ($LASTEXITCODE -ne 0) { Log-Err install "install.ps1 failed (missing API_KEY/URL or other error)"; Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"; exit 1 }
  Log-Ok done "Install checked"
  Write-OwnMindNext
  exit 0
}

# Branch 3: normal upgrade
Log-Info upgrade "Installed; delegating to interactive-upgrade.ps1"
& powershell -ExecutionPolicy Bypass -File "$OwnmindDir\scripts\interactive-upgrade.ps1"
exit $LASTEXITCODE
