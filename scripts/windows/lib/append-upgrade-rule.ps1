# scripts/windows/lib/append-upgrade-rule.ps1
#
# Writes the OwnMind upgrade rule into another AI tool's instruction file, replacing any
# block a previous run left there.
#
# Extracted from update.ps1 in v1.26.140 so the behaviour can be exercised directly. It used
# to be an inline function, and the failure below could only be found by a user running the
# whole updater on a machine that happened to have the wrong file on it.
#
# Reported 2026-08-11 (Amiee, Windows PowerShell 5.1):
#
#     以 "3" 引數呼叫 "Replace" 時發生例外狀況: "值不能為 null。參數名稱: input"
#     於 C:\Users\Amieekuo\.ownmind\scripts\update.ps1:176
#     不可在值為 Null 的運算式上呼叫方法。
#     於 C:\Users\Amieekuo\.ownmind\scripts\update.ps1:180
#
# Root cause: `Get-Content -Raw` returns $null for a zero-byte file — not ''. The old code
# fed that straight into [regex]::Replace(), which rejects a null input, and the assignment
# it was part of therefore never happened, so the next line called .TrimEnd() on $null too.
# Reproduced under pwsh: an existing empty target throws, a missing one and a non-empty one
# both succeed.
#
# The consequence was quiet. Both errors are non-terminating, so the updater continued and
# printed "[ OK ] Upgrade rules synced to detected AI tools" — while that one tool silently
# never received the rule.
#
# Usage:
#   . (Join-Path $OwnMindDir 'scripts\windows\lib\append-upgrade-rule.ps1')
#   Add-OwnMindUpgradeRule -TargetFile "$HOME\.codex\AGENTS.md" -Snippet $snippet

function Add-OwnMindUpgradeRule {
  <#
    .SYNOPSIS
      Replace (or add) the ownmind-upgrade-rule block in one AI tool's instruction file.

    .OUTPUTS
      'written'  — the file now carries the current rule
      'skipped'  — the tool is not installed (its directory does not exist)

      Anything else is a real failure and is thrown, so the caller can report it rather than
      claiming a sync that did not happen.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$TargetFile,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Snippet
  )

  $dir = Split-Path -Parent $TargetFile
  if (-not (Test-Path -LiteralPath $dir)) { return 'skipped' }

  $marker = '<!-- ownmind-upgrade-rule -->'
  $endMarker = '<!-- /ownmind-upgrade-rule -->'

  # ReadAllText, not Get-Content -Raw. Two reasons, and the second is why this is not a
  # matter of taste:
  #
  #   1. -Raw returns $null for a zero-byte file, and '' is what every caller here means.
  #   2. Windows PowerShell 5.1's Get-Content decodes by BOM if there is one and by the
  #      system ANSI code page if there is not — cp950 on the Traditional Chinese Windows
  #      this was reported from. This function writes BOM-less UTF-8, so a -Raw read on the
  #      next update would decode its own output as Big5, mangle every non-ASCII character
  #      in the user's file, and write the damage back. ReadAllText is UTF-8 and honours a
  #      BOM if an older version left one, so files written either way round-trip.
  $existing = ''
  if (Test-Path -LiteralPath $TargetFile) {
    $raw = [System.IO.File]::ReadAllText($TargetFile)
    if (-not [string]::IsNullOrEmpty($raw)) {
      $existing = [regex]::Replace(
        $raw,
        '<!--\s*ownmind-upgrade-rule\s*-->[\s\S]*?<!--\s*/ownmind-upgrade-rule\s*-->\r?\n?',
        '')
    }
  }

  $block = "`r`n$marker`r`n$Snippet`r`n$endMarker`r`n"

  # WriteAllText rather than Set-Content -Encoding UTF8: on PowerShell 5.1 the latter emits a
  # UTF-8 BOM, and these files are read by other vendors' tools.
  [System.IO.File]::WriteAllText($TargetFile, ($existing.TrimEnd() + $block),
    (New-Object System.Text.UTF8Encoding $false))
  return 'written'
}
