[CmdletBinding(DefaultParameterSetName='Install')]
param(
    [Parameter(ParameterSetName='Install')][switch]$Install,
    [Parameter(ParameterSetName='Uninstall',Mandatory=$true)][switch]$Uninstall,
    [Parameter(ParameterSetName='Status',Mandatory=$true)][switch]$Status
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$taskName='Switchboard Stack'
$taskPath='\'

if($Uninstall){
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if($task){
        Unregister-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Confirm:$false
        Write-Host "$taskName uninstalled."
    }else {Write-Host "$taskName is not installed."}
    return
}
if($Status){
    $task=Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
    if(!$task){Write-Host "$taskName is not installed.";return}
    $info=Get-ScheduledTaskInfo -TaskName $taskName -TaskPath $taskPath
    $nextTrigger=($task.Triggers | ForEach-Object {
        if($_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger'){"At log on of $($_.UserId)"}
        else {$_.StartBoundary}
    }) -join '; '
    if($info.NextRunTime -gt [datetime]::MinValue){$nextTrigger="$($info.NextRunTime) ($nextTrigger)"}
    [pscustomobject]@{
        State=$task.State
        LastRunTime=$info.LastRunTime
        LastTaskResult=$info.LastTaskResult
        NextTrigger=$nextTrigger
    } | Format-List
    return
}

$user=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$stackScript=Join-Path $root 'scripts\Stack.ps1'
$action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$stackScript`" -Action Start -NoBrowser -Supervised" -WorkingDirectory $root
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $user
$principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings=New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -TaskPath $taskPath -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Host "$taskName installed for $user at log on."
