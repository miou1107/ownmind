# Download and unpack an OwnMind release archive on a Windows machine that has no git.
#
# The twin of scripts/install-helpers/fetch-release.sh. This file is the single source for the
# download and unpack functions. bootstrap.ps1 cannot dot-source it: bootstrap is fetched over the
# network and run before anything is on disk, so the block between the BEGIN/END markers below is
# EMBEDDED into bootstrap.ps1 byte for byte (line endings aside). tests/bootstrap-archive-mode-ps1.test.js
# fails when the two copies differ. Edit here, then paste the block into bootstrap.ps1.
#
# The functions print the same INFO/OK/ERROR lines as bootstrap.ps1 through Log-Info, Log-Ok and
# Log-Err. When this file is dot-sourced on its own (not from bootstrap.ps1), the fallbacks just
# below define them.
#
# Windows PowerShell 5.1 compatible: no ??, no ternary, no -Parallel. Pure ASCII, no byte order
# mark. No Set-StrictMode at file level, because dot-sourcing would carry it into the caller; each
# function turns it on for itself instead.
#
# The OwnMind archive is a .zip here (the server's ?format=zip variant), because Expand-Archive
# reads nothing else. Invoke-WebRequest takes the Authorization header as an in-process argument,
# so the key never appears on a command line that Get-Process could show.
#
# Env overrides (the same names as fetch-release.sh, even though the GitHub URL is the
# archive endpoint here, not codeload):
#   OWNMIND_SOURCE           server | github: force one archive source (default: server, then github)
#   OWNMIND_GITHUB_API       base URL of the GitHub API   (default https://api.github.com)
#   OWNMIND_GITHUB_CODELOAD  base URL of the GitHub site that serves /<repo>/archive/...
#                            (default https://github.com)

if (-not (Get-Command Log-Info -CommandType Function -ErrorAction SilentlyContinue)) {
  function Log-Info($code, $msg) { Write-Host "INFO:${code}:${msg}" }
  function Log-Ok($code, $msg)   { Write-Host "OK:${code}:${msg}" }
  function Log-Err($code, $msg)  { Write-Host "ERROR:${code}:${msg}" -ForegroundColor Red }
}

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
  # Not $api: PowerShell names ignore case, so `$api = ''` would empty the -Api parameter itself
  # and every download would skip the OwnMind server.
  $apiBase = ''
  if ($Api) { $apiBase = $Api.TrimEnd('/') }
  $global:OwnMindFixApi = $apiBase
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
    Log-Info download "Downloading the release archive from $apiBase"
    if ($Key -and $apiBase) {
      $resp = Invoke-OwnMindDownload -Uri "$apiBase/api/install/archive?format=zip" -Dest $Dest -Headers @{ Authorization = "Bearer $Key" }
      if ($null -ne $resp) { return $result }
    }
    Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    if ($global:OwnMindDiskFull) {
      Log-Err download "Could not save the release archive (the disk is full)"
      Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
      return $null
    }
    if ($source -eq 'server') {
      Log-Err download "Could not download the release archive from $apiBase"
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
