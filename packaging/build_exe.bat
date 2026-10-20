@echo off
rem Baut MT5Bot.exe (ohne Python beim Nutzer). Voraussetzung: Python 3.10-3.13 (64 Bit) und das Projekt im aktuellen Ordner.
rem Ergebnis: dist\MT5Bot\MT5Bot.exe  (den ganzen Ordner dist\MT5Bot weitergeben/kopieren)
cd /d "%~dp0\.."
if not exist .venv\Scripts\python.exe (
    py -3.12 -m venv .venv || py -3 -m venv .venv
)
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -r mt5bot\requirements.txt pyinstaller
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --windowed --name MT5Bot ^
  --add-data "mt5bot\web;mt5bot\web" ^
  --collect-submodules tradingbot --collect-submodules mt5bot --hidden-import MetaTrader5 ^
  packaging\mt5bot_entry.py
if errorlevel 1 ( echo BAU FEHLGESCHLAGEN & pause & exit /b 1 )
echo.
echo Fertig: dist\MT5Bot\MT5Bot.exe
pause
