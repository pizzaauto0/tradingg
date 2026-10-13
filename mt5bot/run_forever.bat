@echo off
rem Startet den MT5-Bot und startet ihn nach einem Absturz automatisch neu.
rem Beenden: dieses Fenster schliessen. Bei Sicherheitsstopp (Echtgeld-Konto) wird NICHT neu gestartet.
title MT5-Bot (laeuft dauerhaft)
cd /d "%~dp0\.."
set MT5BOT_NO_BROWSER=1
if not exist logs mkdir logs
rem Nach dem Anmelden kurz warten, bis Netzwerk und Terminal bereit sind
timeout /t 30 /nobreak >nul

:loop
python -m mt5bot.run
set CODE=%errorlevel%
echo %date% %time% Bot beendet mit Code %CODE% >> logs\neustarts.log
if %CODE%==3 (
    echo SICHERHEITSSTOPP - kein Neustart. Details im Log.
    pause
    exit /b 3
)
if %CODE%==4 (
    echo Python-Paket fehlt - kein Neustart.
    pause
    exit /b 4
)
echo Neustart in 30 Sekunden ...
timeout /t 30 /nobreak >nul
goto loop
