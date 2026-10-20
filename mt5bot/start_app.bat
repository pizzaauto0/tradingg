@echo off
rem Startet die MT5-Bot-App (eigenes Fenster). Einmalig vorher: mt5bot\setup_laptop.bat
cd /d "%~dp0\.."
if exist .venv\Scripts\pythonw.exe (
    start "" .venv\Scripts\pythonw.exe -m mt5bot.app %*
) else (
    echo Die Umgebung fehlt. Bitte zuerst mt5bot\setup_laptop.bat ausfuehren.
    pause
)
