# report-error.ps1 — PowerShell helper (v1.17.79, IR-038)
#
# 用法（dot-source 之後呼叫）：
#   . "$HOME\.ownmind\scripts\install-helpers\report-error.ps1"
#   Report-Error -Kind <kind> -Detail <detail> [-ContextFile <path>]
#
# 設計：永不擋 caller。沒 node / 寫不出檔都靜默吞掉。

function Report-Error {
  param(
    [Parameter(Mandatory=$true)][string]$Kind,
    [string]$Detail = "",
    [string]$ContextFile = ""
  )
  # v1.26.98 — see report-error.sh: Rollback deletes ~/.ownmind before moving the backup
  # back, so the worst failure is the one where this helper no longer exists. An override
  # pointing at a copy kept outside that directory keeps the report possible.
  $helper = $env:OWNMIND_REPORT_HELPER
  if (-not $helper -or -not (Test-Path $helper)) {
    $helper = Join-Path $HOME ".ownmind\scripts\install-helpers\report-error.cjs"
  }
  if (-not (Test-Path $helper)) { return }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return }
  try {
    $args = @($helper, "--kind=$Kind", "--detail=$Detail")
    if ($ContextFile) { $args += "--context-file=$ContextFile" }
    & node @args 2>$null | Out-Null
  } catch { }
}
