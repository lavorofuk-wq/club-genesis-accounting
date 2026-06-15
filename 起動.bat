@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。
  echo Codexに「Node.jsの起動設定を確認して」と伝えてください。
  pause
  exit /b 1
)

start "CLUB GENESIS Local Server" /min cmd /c "node local-server.cjs"
timeout /t 2 /nobreak >nul
start "" "http://localhost:4173/index.html"
