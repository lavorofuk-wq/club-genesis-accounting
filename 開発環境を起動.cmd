@echo off
setlocal
cd /d "%~dp0"

set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if not exist "%NPM_CMD%" goto node_missing

call "%NPM_CMD%" run dev:pc
if errorlevel 1 goto launch_failed
exit /b 0

:node_missing
echo Node.js was not found in Program Files.
echo Please ask Codex to check the Node.js installation.
pause
exit /b 1

:launch_failed
echo GMS development environment failed to start.
echo Please ask Codex to check the launcher logs.
pause
exit /b 1
