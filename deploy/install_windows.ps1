# Windows: in PowerShell im Projektordner ausführen:  powershell -ExecutionPolicy Bypass -File deploy\install_windows.ps1
# Startet den Bot bei jeder Anmeldung unsichtbar im Hintergrund mit niedriger Priorität, Neustart nach Fehlern.
$dir = (Get-Location).Path
$py  = Join-Path $dir ".venv\Scripts\pythonw.exe"
$action   = New-ScheduledTaskAction -Execute $py -Argument "main.py run" -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "TradingBot" -Action $action -Trigger $trigger -Settings $settings -Force
Start-ScheduledTask -TaskName "TradingBot"
# Priorität senken:  (Get-Process pythonw).PriorityClass = "BelowNormal"
# Entfernen:         Unregister-ScheduledTask -TaskName TradingBot -Confirm:$false
