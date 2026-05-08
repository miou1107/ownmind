@echo off
REM v1.17.77: 多層 fallback (回報者 vin-windows-test)
REM 1. where node — PATH 已設好的最快路徑
REM 2. C:\Program Files\nodejs — winget OpenJS.NodeJS.LTS 預設位置
REM 3. %ProgramFiles%\nodejs — 系統碟不是 C: 的環境
REM 4. %LOCALAPPDATA%\Programs\nodejs — winget --scope user 偶爾走這
REM Claude Code spawn cmd.exe 時繼承的 PATH 可能 stale；fallback 守住空窗期。
REM v1.17.79: 全部失敗時，把錯誤資訊 echo 到 errors\ spool 檔（IR-038 觀測管道）。
REM   下次 self-check.cjs 跑時 drainErrorSpool 會把這個 .txt 上傳到 server，
REM   admin dashboard 看得到「user X 的 MCP 起不來」事件，不必等 user 主動回報。

SET NODE_EXE=
FOR /F "tokens=*" %%i IN ('where node 2^>nul') DO SET NODE_EXE=%%i
IF "%NODE_EXE%"=="" IF EXIST "C:\Program Files\nodejs\node.exe" SET NODE_EXE=C:\Program Files\nodejs\node.exe
IF "%NODE_EXE%"=="" IF EXIST "%ProgramFiles%\nodejs\node.exe" SET NODE_EXE=%ProgramFiles%\nodejs\node.exe
IF "%NODE_EXE%"=="" IF EXIST "%LOCALAPPDATA%\Programs\nodejs\node.exe" SET NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe
IF "%NODE_EXE%"=="" (
  REM Build error spool file path: <unix-ish ts>-mcp_start_no_node.txt
  REM cmd.exe 沒 unix timestamp，用 datetime stamp 模擬（仍唯一單調）
  SET "ERRDIR=%USERPROFILE%\.ownmind\logs\errors"
  IF NOT EXIST "%ERRDIR%" MKDIR "%ERRDIR%" >nul 2>&1
  SET "TS=%DATE:/=%%TIME::=%"
  SET "TS=%TS: =0%"
  SET "TS=%TS:.=%"
  SET "ERRFILE=%ERRDIR%\%TS%-mcp_start_no_node.txt"
  > "%ERRFILE%" (
    echo kind=mcp_start_no_node
    echo detail=node.exe not found in PATH or known locations
    echo time=%DATE% %TIME%
    echo searched=PATH; C:\Program Files\nodejs; %%ProgramFiles%%\nodejs; %%LOCALAPPDATA%%\Programs\nodejs
    echo platform=win32
  )
  echo Error: node.exe not found in PATH or known locations: >&2
  echo   - C:\Program Files\nodejs\node.exe >&2
  echo   - %%ProgramFiles%%\nodejs\node.exe >&2
  echo   - %%LOCALAPPDATA%%\Programs\nodejs\node.exe >&2
  echo Fix: install Node.js v20+ from https://nodejs.org/ then restart Claude Code. >&2
  echo Error logged to %ERRFILE% (next OwnMind self-check will upload). >&2
  exit /b 1
)
"%NODE_EXE%" "%~dp0index.js"
