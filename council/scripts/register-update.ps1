$ErrorActionPreference = 'Stop'
$name = 'Council Intelligence Index'
$script = Join-Path $PSScriptRoot 'update-indices.mjs'
$pool = Join-Path $PSScriptRoot 'council-t3.mjs'
if (-not (Test-Path -LiteralPath $script) -or -not (Test-Path -LiteralPath $pool)) { throw 'Updater not found' }
$node = (Get-Command node.exe).Source
$existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
if ($existing -and -not ($existing.Actions | Where-Object { $_.Arguments -like '*council*update-indices.mjs*' })) {
    throw 'A task with this name already exists with a different action; no changes applied'
}
# Two actions per day: Artificial Analysis indices and the free pool (who joined and who left).
$action = @((New-ScheduledTaskAction -Execute $node -Argument "`"$script`" --force" -WorkingDirectory $PSScriptRoot),
    (New-ScheduledTaskAction -Execute $node -Argument "`"$pool`" pool --force" -WorkingDirectory $PSScriptRoot))
$triggers = @((New-ScheduledTaskTrigger -Daily -At '06:00'), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers -Settings $settings -Principal $principal `
    -Description 'Daily GET of the Artificial Analysis Intelligence Index and the OpenRouter free pool for the council. Status in ~/.cache/council.' -Force | Out-Null
Get-ScheduledTaskInfo -TaskName $name | Select-Object TaskName, NextRunTime, LastTaskResult
