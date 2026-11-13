@echo off
rem 名刺管理サーバーを手動で起動します（このウィンドウを閉じると停止します）
cd /d "%~dp0..\.."
if exist "runtime\node.exe" (set NODE=runtime\node.exe) else (set NODE=node)
"%NODE%" dist\server\main.js --log logs\server.log
