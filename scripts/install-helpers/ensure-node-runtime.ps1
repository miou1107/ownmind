# Make sure the installer has a Node.js (v20 or newer) to run on, without winget, a password or a dialog.
#
# The twin of scripts/install-helpers/ensure-node-runtime.sh. A colleague's Windows machine often
# has no Node, or an old one, and winget may be missing or blocked. Instead of asking the person
# to install anything, this downloads the official Node LTS .zip into %USERPROFILE%\.ownmind\runtime\
# and uses that. A machine that already has a Node of v20 or newer keeps using it, and nothing
# else about its install changes.
#
# Dot-sourced, not run: bootstrap.ps1 (after it unpacks the release) and install.ps1 both dot-source
# this file and call `Ensure-OwnMindNode -ApiUrl <url> -ApiKey <key>`, which returns $true or $false.
#
# The runtime is reached through a directory junction, runtime\current -> runtime\node-<version>.
# A junction rather than a symbolic link, because creating a symbolic link on Windows needs a
# privilege that a colleague's account usually does not have; a junction needs none.
#
# Naming and checksum rules must stay identical to shared/node-runtime.js (nodeArchiveName,
# NODE_LTS_MAJOR) and to ensure-node-runtime.sh; tests/install-ps1-private-node.test.js compares them.
#
# Windows PowerShell 5.1 compatible. Pure ASCII, no byte order mark. No Set-StrictMode at file
# level (dot-sourcing would carry it into the caller); each function turns it on for itself.
#
# Env overrides (tests and company networks; same names as the shell twin):
#   OWNMIND_DIR          install path (default %USERPROFILE%\.ownmind)
#   OWNMIND_NODE_SOURCE  server | nodejs: force one download source (default: server, then nodejs)
#   OWNMIND_NODE_DIST    base URL of the nodejs.org dist tree (default https://nodejs.org/dist)

# fetch-release.ps1 holds the download helper (Invoke-OwnMindDownload, TLS 1.2, retries) and the
# Log-Info / Log-Ok / Log-Err fallbacks. It is dot-sourced, not copied, so a fix there is a fix here.
. (Join-Path $PSScriptRoot 'fetch-release.ps1')

# The Node line OwnMind runs on. Must equal NODE_LTS_MAJOR in shared/node-runtime.js.
$script:OwnMindNodeLtsMajor = 22
$script:OwnMindNodeFloorMajor = 20

# The full version ("v22.11.0") that `node.exe --version` reports for NodeExe, or an empty
# string when the file is missing, does not run, or does not answer with a version.
function Get-OwnMindNodeVersionOf {
  param([string]$NodeExe)
  Set-StrictMode -Version Latest
  if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { return '' }
  try {
    $raw = & $NodeExe --version 2>$null
    $code = -1
    if (Test-Path variable:LASTEXITCODE) { $code = $LASTEXITCODE }
    if ($code -ne 0) { return '' }
    $text = "$raw".Trim()
    if ([regex]::IsMatch($text, '^v\d+\.\d+\.\d+$')) { return $text }
    return ''
  } catch { return '' }
}

# The major number of a version like "v22.11.0", or -1.
function Get-OwnMindNodeMajorOf {
  param([string]$Version)
  Set-StrictMode -Version Latest
  $m = [regex]::Match($Version, '^v(\d+)\.')
  if (-not $m.Success) { return -1 }
  return [int]$m.Groups[1].Value
}

# Archive name for a version like v22.11.0 and an arch of arm64 or x64. Same shape as
# nodeArchiveName({ os: 'win32', arch, version }) in shared/node-runtime.js.
function Get-OwnMindNodeArchiveName {
  param([string]$Version, [string]$Arch)
  return "node-$Version-win-$Arch.zip"
}

# x64 or arm64, or an empty string for any other CPU. A 32-bit PowerShell on a 64-bit Windows
# reports x86 in PROCESSOR_ARCHITECTURE and the real CPU in PROCESSOR_ARCHITEW6432.
function Get-OwnMindNodeArch {
  Set-StrictMode -Version Latest
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
  if ($arch -eq 'AMD64') { return 'x64' }
  if ($arch -eq 'ARM64') { return 'arm64' }
  return ''
}

# Test-OwnMindFileSha256 -File FILE -Expected HEX. Deletes FILE and returns $false when the
# checksum differs (or the file cannot be read).
function Test-OwnMindFileSha256 {
  param([string]$File, [string]$Expected)
  Set-StrictMode -Version Latest
  $hash = ''
  try { $hash = (Get-FileHash -LiteralPath $File -Algorithm SHA256 -ErrorAction Stop).Hash } catch { $hash = '' }
  if (-not $hash -or $hash.ToLowerInvariant() -ne $Expected.Trim().ToLowerInvariant()) {
    Remove-Item -LiteralPath $File -Force -ErrorAction SilentlyContinue
    return $false
  }
  return $true
}

# Get-OwnMindNodeFromServer -Api URL -Key KEY -Arch ARCH -Dest FILE
# Downloads the archive from the OwnMind server and reads the version and checksum from the
# response headers (X-Node-Version, X-Sha256). Returns @{ Version; Sha } or $null.
function Get-OwnMindNodeFromServer {
  param([string]$Api, [string]$Key, [string]$Arch, [string]$Dest)
  Set-StrictMode -Version Latest
  $api = $Api.TrimEnd('/')
  if (-not $api -or -not $Key) { return $null }
  Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  Log-Info node "Downloading Node.js from $api"
  $resp = Invoke-OwnMindDownload -Uri "$api/api/install/node?os=win32&arch=$Arch" -Dest $Dest -Headers @{ Authorization = "Bearer $Key" }
  if ($null -eq $resp) { return $null }
  $version = Get-OwnMindHeader -Response $resp -Name 'X-Node-Version'
  $sha = Get-OwnMindHeader -Response $resp -Name 'X-Sha256'
  if (-not [regex]::IsMatch($version, '^v\d+\.\d+\.\d+$') -or -not [regex]::IsMatch($sha, '^[0-9a-fA-F]{64}$')) {
    Log-Info node "The OwnMind server did not send a version and checksum for Node.js"
    Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
    return $null
  }
  if (-not (Test-OwnMindFileSha256 -File $Dest -Expected $sha)) { return $null }
  return @{ Version = $version; Sha = $sha }
}

# Get-OwnMindNodeFromNodejs -Arch ARCH -Dest FILE
# Newest v22.x.y from nodejs.org's index, its archive, and the checksum from SHASUMS256.txt.
# Returns @{ Version; Sha } or $null.
function Get-OwnMindNodeFromNodejs {
  param([string]$Arch, [string]$Dest)
  Set-StrictMode -Version Latest
  $dist = 'https://nodejs.org/dist'
  if ($env:OWNMIND_NODE_DIST) { $dist = $env:OWNMIND_NODE_DIST }
  $dist = $dist.TrimEnd('/')
  Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue
  Log-Info node "Downloading Node.js from $dist"

  $indexFile = "$Dest.index.json"
  $r = Invoke-OwnMindDownload -Uri "$dist/index.json" -Dest $indexFile
  if ($null -eq $r) { return $null }
  $index = ''
  try { $index = [System.IO.File]::ReadAllText($indexFile) } catch { $index = '' }
  Remove-Item -LiteralPath $indexFile -Force -ErrorAction SilentlyContinue
  $best = $null
  $version = ''
  $pattern = '"version"\s*:\s*"(v' + $script:OwnMindNodeLtsMajor + '\.(\d+)\.(\d+))"'
  foreach ($m in [regex]::Matches($index, $pattern)) {
    try { $v = [version]($m.Groups[1].Value.Substring(1)) } catch { continue }
    if ($null -eq $best -or $v -gt $best) { $best = $v; $version = $m.Groups[1].Value }
  }
  if (-not $version) { return $null }

  $name = Get-OwnMindNodeArchiveName -Version $version -Arch $Arch
  $sumsFile = "$Dest.sums"
  $r = Invoke-OwnMindDownload -Uri "$dist/$version/SHASUMS256.txt" -Dest $sumsFile
  if ($null -eq $r) { return $null }
  $sums = ''
  try { $sums = [System.IO.File]::ReadAllText($sumsFile) } catch { $sums = '' }
  Remove-Item -LiteralPath $sumsFile -Force -ErrorAction SilentlyContinue
  $sha = ''
  foreach ($line in ($sums -split "`n")) {
    $parts = @($line.Trim() -split '\s+')
    if ($parts.Count -ge 2 -and $parts[1] -eq $name) { $sha = $parts[0]; break }
  }
  if (-not $sha) { return $null }

  $r = Invoke-OwnMindDownload -Uri "$dist/$version/$name" -Dest $Dest
  if ($null -eq $r) { return $null }
  if (-not (Test-OwnMindFileSha256 -File $Dest -Expected $sha)) { return $null }
  return @{ Version = $version; Sha = $sha }
}

# The attributes of a path WITHOUT following it, or $null when nothing is there. Test-Path and
# Get-Item follow a directory junction, so a junction whose target is gone looks like "no such
# path" to them, while the junction itself is still there and still blocks a new one.
function Get-OwnMindPathAttributes {
  param([string]$Path)
  try { return [System.IO.File]::GetAttributes($Path) } catch { return $null }
}

# Remove runtime\current whatever it is, including a junction whose target is gone: a junction
# goes without touching what it points at, and a real folder (left by hand or an older layout)
# is deleted, because New-Item would otherwise fail or link inside it.
function Remove-OwnMindCurrent {
  param([string]$Current)
  Set-StrictMode -Version Latest
  $attrs = Get-OwnMindPathAttributes -Path $Current
  if ($null -eq $attrs) { return }
  if (($attrs -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    [System.IO.Directory]::Delete($Current)
  } else {
    Remove-Item -LiteralPath $Current -Recurse -Force
  }
}

# Where runtime\current points, or an empty string when it is not a junction (or its target cannot be read).
function Get-OwnMindCurrentTarget {
  param([string]$Current)
  Set-StrictMode -Version Latest
  $attrs = Get-OwnMindPathAttributes -Path $Current
  if ($null -eq $attrs -or ($attrs -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { return '' }
  try {
    $target = @((Get-Item -LiteralPath $Current -Force -ErrorAction Stop).Target)
    if ($target.Count -gt 0 -and $target[0]) { return [string]$target[0] }
  } catch { }
  return ''
}

# Put runtime\current back where it pointed before this attempt (nothing when it pointed nowhere).
function Restore-OwnMindCurrent {
  param([string]$Current, [string]$Previous)
  Set-StrictMode -Version Latest
  try { Remove-OwnMindCurrent -Current $Current } catch { }
  if ($Previous -and (Test-Path -LiteralPath $Previous)) {
    try { New-Item -ItemType Junction -Path $Current -Value $Previous -ErrorAction Stop | Out-Null } catch { }
  }
}

# Export the private runtime for the rest of the install.
function Use-OwnMindPrivateNode {
  param([string]$Runtime)
  Set-StrictMode -Version Latest
  $current = Join-Path $Runtime 'current'
  $env:OWNMIND_NODE = Join-Path $current 'node.exe'
  $env:OWNMIND_PRIVATE_NODE = '1'
  $onPath = $false
  foreach ($part in ($env:Path -split ';')) {
    if ($part -and ($part.TrimEnd('\') -ieq $current.TrimEnd('\'))) { $onPath = $true; break }
  }
  if (-not $onPath) { $env:Path = "$current;$env:Path" }
  $noBom = New-Object System.Text.UTF8Encoding $false
  try {
    [System.IO.File]::WriteAllText((Join-Path (Split-Path -Parent $Runtime) '.node-path'), "$($env:OWNMIND_NODE)`n", $noBom)
  } catch {
    Write-OwnMindStopWrite -Code node_download -Message 'Could not write .node-path' -ErrorRecord $_
    return $false
  }
  return $true
}

# Ensure-OwnMindNode -ApiUrl URL -ApiKey KEY
# Returns $true with OWNMIND_NODE set to a Node of v20 or newer; returns $false after printing
# ERROR / ASK lines when none could be found or downloaded.
function Ensure-OwnMindNode {
  param([string]$ApiUrl = '', [string]$ApiKey = '')
  Set-StrictMode -Version Latest
  $api = $ApiUrl.TrimEnd('/')
  if ($api) { $global:OwnMindFixApi = $api }
  # Windows PowerShell 5.1 redraws a progress bar for every entry of the Node zip (about 2,500),
  # which is most of the unpack time; with it off the unpack takes seconds.
  $ProgressPreference = 'SilentlyContinue'
  $key = $ApiKey
  if (-not $key -and $env:OWNMIND_INSTALL_KEY) { $key = $env:OWNMIND_INSTALL_KEY }
  $base = $env:OWNMIND_DIR
  if (-not $base) {
    $userHome = $env:USERPROFILE
    if (-not $userHome) { $userHome = $HOME }
    $base = Join-Path $userHome '.ownmind'
  }
  $base = [System.IO.Path]::GetFullPath($base)
  $runtime = Join-Path $base 'runtime'
  $partial = Join-Path $runtime '.partial'
  $current = Join-Path $runtime 'current'
  $currentNode = Join-Path $current 'node.exe'
  $source = ''
  if ($env:OWNMIND_NODE_SOURCE) { $source = $env:OWNMIND_NODE_SOURCE }

  if ($source -ne '' -and $source -ne 'server' -and $source -ne 'nodejs') {
    Log-Err node_download "OWNMIND_NODE_SOURCE must be server or nodejs (got: $source)"
    Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand -Source clear-node)"
    return $false
  }

  # 1. A Node of v20 or newer on PATH is used as it is.
  $sysCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue
  if ($sysCmd) {
    $sysNode = [string]@($sysCmd)[0].Source
    $sysVer = Get-OwnMindNodeVersionOf $sysNode
    if ($sysVer -and (Get-OwnMindNodeMajorOf $sysVer) -ge $script:OwnMindNodeFloorMajor) {
      if ($sysNode -ieq $currentNode) {
        # An earlier step of this same install already put the private runtime first on PATH.
        # grammar-allow: Use-OwnMindPrivateNode has already printed its own ERROR with FIX or ASK
        if (-not (Use-OwnMindPrivateNode -Runtime $runtime)) { return $false }
        Log-Info node "using private Node $sysVer"
      } else {
        $env:OWNMIND_NODE = $sysNode
        Remove-Item Env:OWNMIND_PRIVATE_NODE -ErrorAction SilentlyContinue
        Log-Info node "using system node $sysVer"
      }
      return $true
    }
  }

  # 2. A private runtime from an earlier install is reused without a download.
  $privVer = Get-OwnMindNodeVersionOf $currentNode
  if ($privVer -and (Get-OwnMindNodeMajorOf $privVer) -ge $script:OwnMindNodeFloorMajor) {
    # grammar-allow: Use-OwnMindPrivateNode has already printed its own ERROR with FIX or ASK
    if (-not (Use-OwnMindPrivateNode -Runtime $runtime)) { return $false }
    Log-Info node "using private Node $privVer"
    return $true
  }

  # 3. Download one.
  $arch = Get-OwnMindNodeArch
  if (-not $arch) {
    Log-Err node_download "No Node.js download exists for this CPU ($($env:PROCESSOR_ARCHITECTURE))"
    Write-OwnMindAsk -Code unsupported_os -Literal "ASK:unsupported_os:The installer only supports macOS and Windows for now, so it cannot install on this computer's system."
    return $false
  }
  try {
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $partial -ErrorAction Stop | Out-Null
  } catch {
    Write-OwnMindStopWrite -Code node_download -Message "Could not create $partial" -ErrorRecord $_
    return $false
  }

  Log-Info node_download "trying the OwnMind server, then nodejs.org (this can take a few minutes when offline)"
  $global:OwnMindDiskFull = $false
  $zip = Join-Path $partial 'node.zip'
  $got = $null
  if ($source -ne 'nodejs') {
    $got = @(Get-OwnMindNodeFromServer -Api $api -Key $key -Arch $arch -Dest $zip) | Select-Object -Last 1
  }
  if ($null -eq $got -and $source -ne 'server') {
    if ($source -ne 'nodejs') { Log-Info node "The OwnMind server did not deliver Node.js; trying nodejs.org" }
    $got = @(Get-OwnMindNodeFromNodejs -Arch $arch -Dest $zip) | Select-Object -Last 1
  }
  if ($null -eq $got) {
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    if ($global:OwnMindDiskFull) {
      Log-Err node_download "Could not save the Node.js download (the disk is full)"
      Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
      return $false
    }
    Log-Err node_download "Could not download Node.js from the OwnMind server or nodejs.org"
    Write-OwnMindAsk -Code node_download -Literal "ASK:node_download:The installer could not download Node.js from the OwnMind server or nodejs.org. Check that this computer is online, then paste the same install message to the AI again."
    return $false
  }
  $version = [string]$got.Version

  # The official archive has one folder inside, node-<version>-win-<arch>; its content becomes
  # runtime\node-<version>.
  $unpack = Join-Path $partial 'unpack'
  try {
    New-Item -ItemType Directory -Force -Path $unpack -ErrorAction Stop | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $unpack -Force -ErrorAction Stop
  } catch {
    $full = Test-OwnMindDiskFull $_
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    if ($full) {
      Log-Err node_download "Could not unpack the Node.js archive (the disk is full)"
      Write-OwnMindAsk -Code disk_full -Literal "ASK:disk_full:This computer is out of disk space, so the installer stopped. Free at least 500 MB, then paste the same install message to the AI again."
    } else {
      Log-Err node_download "Could not unpack the Node.js archive (it may be damaged)"
      Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
    }
    return $false
  }
  $inner = @(Get-ChildItem -LiteralPath $unpack -Force)
  if ($inner.Count -ne 1 -or -not $inner[0].PSIsContainer) {
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    Log-Err node_download "The Node.js archive does not have the one top-level folder that was expected"
    Write-Host "FIX:retry_install:$(Get-OwnMindRetryCommand)"
    return $false
  }

  # Remember where current pointed, so a failed attempt can put it back. Then take current out of
  # the way BEFORE node-<version> is deleted: a junction left pointing at a folder that is about
  # to disappear (or that already has) would otherwise block the new one for good.
  $prev = Get-OwnMindCurrentTarget -Current $current
  try {
    Remove-OwnMindCurrent -Current $current
  } catch {
    $stopError = $_
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    Write-OwnMindStopWrite -Code node_download -Message "Could not replace $current" -ErrorRecord $stopError
    return $false
  }
  $dest = Join-Path $runtime "node-$version"
  Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
  try {
    Move-OwnMindItemRetry -Path $inner[0].FullName -Destination $dest
  } catch {
    $stopError = $_
    Restore-OwnMindCurrent -Current $current -Previous $prev
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    Write-OwnMindStopWrite -Code node_download -Message "Could not move Node.js into $runtime" -ErrorRecord $stopError
    return $false
  }
  try {
    New-Item -ItemType Junction -Path $current -Value $dest -ErrorAction Stop | Out-Null
  } catch {
    $stopError = $_
    Restore-OwnMindCurrent -Current $current -Previous $prev
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    Write-OwnMindStopWrite -Code node_download -Message "Could not link $current to the new Node.js" -ErrorRecord $stopError
    return $false
  }
  $gotVer = Get-OwnMindNodeVersionOf $currentNode
  if ($gotVer -ne $version) {
    # Put things back the way they were before this attempt.
    Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
    Restore-OwnMindCurrent -Current $current -Previous $prev
    Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue
    $said = $gotVer
    if (-not $said) { $said = 'nothing' }
    Log-Err node_download "The downloaded Node.js did not run (expected $version, got $said)"
    Write-OwnMindAsk -Code node_download -Literal "ASK:node_download:The installer could not download Node.js from the OwnMind server or nodejs.org. Check that this computer is online, then paste the same install message to the AI again."
    return $false
  }
  Remove-Item -LiteralPath $partial -Recurse -Force -ErrorAction SilentlyContinue

  # grammar-allow: Use-OwnMindPrivateNode has already printed its own ERROR with FIX or ASK
  if (-not (Use-OwnMindPrivateNode -Runtime $runtime)) { return $false }
  Log-Ok node "private Node $version installed"
  return $true
}
