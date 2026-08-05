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

Dim sh, cmd, i, rc
Set sh = CreateObject("WScript.Shell")
cmd = ""

For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & " """ & WScript.Arguments(i) & """"
Next

If Trim(cmd) = "" Then
  WScript.Quit 1
End If

' 0 = SW_HIDE（隱藏視窗）、True = 等子程序跑完並取得它的 exit code。
'
' v1.26.65 — 這裡以前是 False（fire-and-forget）。Run 在 False 的時候會立刻回傳、
' 而且固定回傳 0，所以 wscript.exe 永遠以 0 結束：node 有沒有跑起來、有沒有當掉、
' 那個路徑的 node 還在不在，Task Scheduler 記到的 LastTaskResult 都是 0（成功）。
'
' 後果比「少一個訊號」嚴重：這個故障的標準診斷步驟就是去看 LastTaskResult，而那個
' 檢查在這種狀況下不可能失敗。2026-08-05 追 Adam 的掃描器時就是這樣，他的排程回報
' 一切正常，實際上二十天沒有送出任何資料。
'
' 等待的代價：task 在掃描期間會顯示 running。這是對的，而且註冊時設的
' ExecutionTimeLimit 10 分鐘本來就是為了這件事。
rc = sh.Run(Trim(cmd), 0, True)
WScript.Quit rc
