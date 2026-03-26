@echo off
FOR /F "tokens=*" %%i IN ('where node 2^>nul') DO SET NODE_EXE=%%i
IF "%NODE_EXE%"=="" (
  echo Error: node.exe not found in PATH >&2
  exit /b 1
)
"%NODE_EXE%" "%~dp0index.js"
