' run-hidden.vbs — 把後面的命令隱藏視窗背景跑
'
' 用法：wscript.exe run-hidden.vbs <executable> [args...]
'
' 為什麼用 VBS：
'   wscript.exe 是 GUI subsystem launcher（不開 console）；它再用 SW_HIDE flag
'   spawn 任何 console subsystem binary（如 node.exe），子程序連 console window
'   都不會分配。這是 Windows 社群最廣的「Task Scheduler 跑 console 程式不顯示
'   視窗」標準解法。
'
' 替代方案為什麼不選：
'   - powershell -WindowStyle Hidden：powershell.exe 自己仍會閃一下視窗
'   - LogonType S4U：Service-For-User 模式不顯示視窗，但限制不能存取網路資源；
'     OwnMind scanner 要連 server，不能用 S4U
'   - Windows Service：要 admin 權限，部署成本高，沒必要

Option Explicit

Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = ""

For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

If Trim(cmd) = "" Then
  WScript.Quit 1
End If

' 0 = SW_HIDE（隱藏視窗），False = 不等待子程序回傳（fire-and-forget）
sh.Run Trim(cmd), 0, False
