@echo off
rem Double-click to start the confession booth on Windows (needs Node.js and Chrome or Edge).
cd /d "%~dp0"
node scripts\start-booth.js
if errorlevel 1 pause
