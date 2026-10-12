@echo off
title MT5-Bot (Demo)
cd /d "%~dp0\.."
python --version >nul 2>&1
if errorlevel 1 (
    echo FEHLER: Python nicht gefunden.
    pause
    exit /b 1
)
echo MetaTrader 5 muss laufen, Demo-Konto eingeloggt und "Algo-Handel" gruen sein.
echo Stoppen: Strg + C  (Stop-Loss/Take-Profit bleiben beim Broker aktiv)
echo Notaus: leere Datei KILL_SWITCH im Projektordner anlegen.
echo.
python -m mt5bot.run
echo.
pause
