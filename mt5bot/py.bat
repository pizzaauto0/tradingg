@echo off
rem Fuehrt Python aus der Bot-Umgebung (.venv) aus, z. B.:  mt5bot\py.bat -m mt5bot.run
cd /d "%~dp0\.."
if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe %*
) else (
    echo Die Umgebung fehlt. Bitte zuerst mt5bot\setup_laptop.bat ausfuehren.
    exit /b 1
)
