@echo off
chcp 65001 >nul
title MT5-Bot Einrichtung
cd /d "%~dp0\.."
echo ============================================================
echo   MT5-Bot: Einrichtung (einmalig)
echo ============================================================
echo.

rem --- Passende Python-Version suchen: das Paket MetaTrader5 gibt es nur fuer Python 3.10 bis 3.13 (64-Bit) ---
set PYEXE=
for %%V in (3.13 3.12 3.11 3.10) do (
    if not defined PYEXE (
        py -%%V -c "import sys" >nul 2>&1 && set "PYEXE=py -%%V"
    )
)
if not defined PYEXE (
    python -c "import sys; sys.exit(0 if (3,10)<=sys.version_info[:2]<=(3,13) else 1)" >nul 2>&1 && set "PYEXE=python"
)
if not defined PYEXE (
    echo FEHLER: Keine passende Python-Version gefunden.
    echo.
    echo Das Paket MetaTrader5 braucht Python 3.10 bis 3.13 ^(64-Bit^). Neuere Versionen ^(z. B. 3.14/3.15^) gehen NICHT.
    echo Installiere zusaetzlich Python 3.13 von https://www.python.org/downloads/windows/
    echo ^(unter "Python 3.13.x" den "Windows installer ^(64-bit^)" waehlen^).
    echo Beim Installieren: "Add python.exe to PATH" und "py launcher" angekreuzt lassen.
    echo Deine neuere Python-Version darf installiert bleiben. Danach setup_laptop.bat erneut starten.
    pause
    exit /b 1
)
echo Verwende: %PYEXE%
%PYEXE% --version
echo.

echo [1/4] Eigene Umgebung anlegen (.venv) ...
if not exist .venv\Scripts\python.exe (
    %PYEXE% -m venv .venv
    if errorlevel 1 (
        echo FEHLER: Umgebung konnte nicht angelegt werden.
        pause
        exit /b 1
    )
)
echo OK
echo.

echo [2/4] Pakete installieren ...
.venv\Scripts\python.exe -m pip install --upgrade pip >nul 2>&1
.venv\Scripts\python.exe -m pip install -r mt5bot\requirements.txt
if errorlevel 1 (
    echo FEHLER bei der Paket-Installation. Meldung oben lesen oder mir schicken.
    echo Hinweis: MetaTrader5 gibt es nur fuer 64-Bit-Windows mit 64-Bit-Python 3.10 bis 3.13.
    pause
    exit /b 1
)
echo.

echo [3/4] Selbsttest ...
.venv\Scripts\python.exe -c "import mt5bot.runner, MetaTrader5; print('OK: Bot und MetaTrader5-Paket sind installiert')"
if errorlevel 1 (
    echo FEHLER: Selbsttest fehlgeschlagen. Meldung oben lesen oder mir schicken.
    pause
    exit /b 1
)
if not exist logs mkdir logs
echo.

echo [4/4] Fertig. Ab jetzt IMMER diese Befehle benutzen (nicht "python ..."):
echo.
echo   Start:      mt5bot\py.bat -m mt5bot.run
echo   Telegram:   mt5bot\py.bat -m mt5bot.telegram_setup
echo   Autostart:  mt5bot\py.bat -m mt5bot.autostart install
echo.
echo Vorher: MetaTrader 5 installieren, Demo-Konto einloggen, oben "Algo-Handel" gruen.
echo Details: mt5bot\LAPTOP.md
pause
