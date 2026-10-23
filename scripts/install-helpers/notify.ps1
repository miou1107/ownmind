# notify.ps1 — shows one desktop notification titled "OwnMind" on Windows 10/11.
# Usage: powershell -File notify.ps1 -Text "<sentence>"
#
# First choice is a toast (Windows.UI.Notifications) sent under PowerShell's own app id, which
# Windows already knows, so no shortcut has to be registered. When that is not available it shows
# a System.Windows.Forms.NotifyIcon balloon for 10 seconds (Windows PowerShell 5.1 has both).
# It never throws and always exits 0: a notification that cannot be shown must not fail whatever
# started it.
param(
  [string]$Text = '',
  [string]$Title = 'OwnMind'
)

$ErrorActionPreference = 'Stop'
if (-not $Text) { exit 0 }

$shown = $false
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $nodes = $xml.GetElementsByTagName('text')
  # InnerText escapes the sentence; it is never pasted into XML text.
  $nodes.Item(0).InnerText = $Title
  $nodes.Item(1).InnerText = $Text
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  $shown = $true
} catch { $shown = $false }

if (-not $shown) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icon = New-Object System.Windows.Forms.NotifyIcon
    $icon.Icon = [System.Drawing.SystemIcons]::Information
    $icon.Visible = $true
    $icon.ShowBalloonTip(10000, $Title, $Text, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 10
    $icon.Dispose()
  } catch { }
}
exit 0
