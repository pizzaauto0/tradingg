@echo off
chcp 65001 >nul
title MT5-Bot Einrichtung
cd /d "%~dp0\.."
echo ============================================================
echo   MT5-Bot: Einrichtung (einmalig)
echo ============================================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo FEHLER: Python wurde nicht gefunden.
    echo Installiere Python 3.11 oder neuer von https://www.python.org/downloads/
    echo WICHTIG: Beim Installieren unten "Add python.exe to PATH" ankreuzen!
    echo Danach dieses Fenster schliessen und setup_laptop.bat erneut starten.
    pause
    exit /b 1
)
python --version
echo.

echo [1/4] Pakete installieren ...
python -m pip install --upgrade pip >nul 2>&1
python -m pip install -r mt5bot\requirements.txt
if errorlevel 1 (
    echo FEHLER bei der Paket-Installation. Meldung oben lesen oder mir schicken.
    pause
    exit /b 1
)
echo.

echo [2/4] Selbsttest (Python-Teil) ...
python -c "import mt5bot.runner, MetaTrader5; print('OK: Bot und MetaTrader5-Paket sind installiert')"
if errorlevel 1 (
    echo FEHLER: Selbsttest fehlgeschlagen. Meldung oben lesen oder mir schicken.
    echo Hinweis: Das Paket MetaTrader5 gibt es nur fuer 64-Bit-Windows mit 64-Bit-Python.
    pause
    exit /b 1
)
echo.

echo [3/4] Ordner und Schutzdateien ...
if not exist logs mkdir logs
echo OK
echo.

echo [4/4] Fertig. Noch von Hand zu tun:
echo   a) MetaTrader 5 installieren (vom Broker), Demo-Konto einloggen, oben "Algo-Handel" gruen.
echo   b) Telegram:   python -m mt5bot.telegram_setup
echo   c) Start:      python -m mt5bot.run
echo   d) Autostart:  python -m mt5bot.autostart install
echo.
echo Details: mt5bot\LAPTOP.md
pause
