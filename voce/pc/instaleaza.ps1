# Rulează o dată, ca Administrator: task-ul care pornește difuzorul la logare + portul 8100 în firewall,
# deschis doar pentru rețeaua locală și Tailscale.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $dir "difuzor.ps1"
$user = "$env:USERDOMAIN\$env:USERNAME"
if ($args.Count -gt 0) { $user = $args[0] }

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 `
    -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive
Register-ScheduledTask -TaskName "Claude voce" -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null

Get-NetFirewallRule -DisplayName "Claude voce 8100" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "Claude voce 8100" -Direction Inbound -Protocol TCP -LocalPort 8100 `
    -RemoteAddress 192.168.1.0/24, 100.64.0.0/10 -Action Allow | Out-Null

Write-Output "gata: task 'Claude voce' pentru $user + firewall 8100"
