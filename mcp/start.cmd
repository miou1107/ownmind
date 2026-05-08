@echo off
REM v1.17.77: 多層 fallback (回報者 vin-windows-test)
REM 1. where node — PATH 已設好的最快路徑
REM 2. C:\Program Files\nodejs — winget OpenJS.NodeJS.LTS 預設位置
REM 3. %ProgramFiles%\nodejs — 系統碟不是 C: 的環境
REM 4. %LOCALAPPDATA%\Programs\nodejs — winget --scope user 偶爾走這
REM Claude Code spawn cmd.exe 時繼承的 PATH 可能 stale；fallback 守住空窗期。

SET NODE_EXE=
FOR /F "tokens=*" %%i IN ('where node 2^>nul') DO SET NODE_EXE=%%i
IF "%NODE_EXE%"=="" IF EXIST "C:\Program Files\nodejs\node.exe" SET NODE_EXE=C:\Program Files\nodejs\node.exe
IF "%NODE_EXE%"=="" IF EXIST "%ProgramFiles%\nodejs\node.exe" SET NODE_EXE=%ProgramFiles%\nodejs\node.exe
IF "%NODE_EXE%"=="" IF EXIST "%LOCALAPPDATA%\Programs\nodejs\node.exe" SET NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe
IF "%NODE_EXE%"=="" (
  echo Error: node.exe not found in PATH or known locations: >&2
  echo   - C:\Program Files\nodejs\node.exe >&2
  echo   - %%ProgramFiles%%\nodejs\node.exe >&2
  echo   - %%LOCALAPPDATA%%\Programs\nodejs\node.exe >&2
  echo Fix: install Node.js v20+ from https://nodejs.org/ then restart Claude Code. >&2
  exit /b 1
)
"%NODE_EXE%" "%~dp0index.js"
