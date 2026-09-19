param([ValidateSet('Start','Stop')][string]$Action='Start',[switch]$NoBrowser,[ValidateRange(0,3600)][int]$WaitSeconds=30,[switch]$Supervised)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$config=@{}
if(Test-Path switchboard.config.json){$config=Get-Content switchboard.config.json -Raw | ConvertFrom-Json}
$port=4680
if($config.port){$port=[int]$config.port}
$url="http://127.0.0.1:$port"
$data=Join-Path $root 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$pidFile=Join-Path $data 'production.pid'
$entry=Join-Path $root 'src\index.ts'
# Serialize repeated clicks, including START racing END.
try {$lock=[IO.File]::Open((Join-Path $data 'stack-control.lock'),'OpenOrCreate','ReadWrite','None')}
catch {throw 'Another stack START/END is in progress.'}
function Get-Server {
    $listeners=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $port)
    if(!$listeners.Count){return $null}
    $owners=@($listeners.OwningProcess | Select-Object -Unique)
    if($owners.Count -ne 1){throw 'Unexpected listeners on the board port.'}
    $server=Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])"
    $owned=$server.Name -eq 'node.exe' -and $server.CommandLine.Contains($entry)
    # Adopt the old production launcher only with its PID and known entrypoint.
    if(!$owned -and (Test-Path -LiteralPath $pidFile)){
        $recorded=(Get-Content -LiteralPath $pidFile -Raw).Trim()
        $owned=$server.Name -eq 'node.exe' -and "$($server.ProcessId)" -eq $recorded -and $server.CommandLine -match '--import\s+tsx\s+src/index\.ts\s*$'
    }
    if(!$owned){throw "Port $port belongs to an unrecognized process. Leaving it alone."}
    return $server
}
function Get-State {Invoke-RestMethod "$url/api/state" -TimeoutSec 5}
try {
    $server=Get-Server
    if($Action -eq 'Start'){
        if(!$server){
            $node=(Get-Command node.exe).Source
            if(!(Test-Path node_modules/tsx)){throw 'Dependencies missing. Run npm ci in this folder first.'}
            if($config.remote -and @(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $config.remote.port).Count){throw 'Worker listener port is occupied.'}
            $stamp=Get-Date -Format 'yyyyMMdd-HHmmss'
            $stdoutLog=Join-Path $data "production-$stamp.stdout.log"
            $stderrLog=Join-Path $data "production-$stamp.stderr.log"
            $started=Start-Process $node -ArgumentList "--import tsx `"$entry`"" -WorkingDirectory $root -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
            Set-Content -LiteralPath $pidFile $started.Id
            $ready=$false
            for($i=0;$i -lt 30;$i++){
                $started.Refresh()
                if($started.HasExited){throw "Server exited. See $stderrLog."}
                try {$null=Invoke-RestMethod "$url/health/ready" -TimeoutSec 5;$ready=$true;break} catch {Start-Sleep -Milliseconds 500}
            }
            if(!$ready){throw 'Startup not ready. Check production logs before retrying.'}
            $server=Get-Server
            if(!$Supervised){
                $null=Invoke-RestMethod "$url/api/drain/clear" -Method Post -TimeoutSec 5
                $null=Invoke-RestMethod "$url/api/resume" -Method Post -TimeoutSec 5
            }
        }
        $state=Get-State
        if($config.remote){
            $listeners=@(Get-NetTCPConnection -State Listen | Where-Object {$_.LocalPort -eq $config.remote.port -and $_.OwningProcess -eq $server.ProcessId})
            if(!$listeners.Count){throw 'Board is up but worker listener is not ready. Check production logs.'}
        }
        foreach($stream in @('stdout','stderr')){
            Get-ChildItem -LiteralPath $data -Filter "production-*.$stream.log" -File |
                Sort-Object Name -Descending | Select-Object -Skip 10 |
                ForEach-Object {Remove-Item -LiteralPath $_.FullName}
        }
        Write-Host "Stack ready: $url/ (board, MCP, dispatcher, configured worker listener; paused=$($state.paused), draining=$($state.draining))"
        if(!$NoBrowser){Start-Process "$url/"}
    }else{
        if(!$server){Write-Host 'Switchboard is already stopped.';return}
        $null=Invoke-RestMethod "$url/api/drain" -Method Post -TimeoutSec 5
        $deadline=(Get-Date).AddSeconds($WaitSeconds)
        do {
            $state=Get-State
            if(@($state.activeRuns).Count -eq 0){break}
            if((Get-Date) -ge $deadline){throw 'Jobs still active. Host stays draining; run END again when they finish. No process was killed.'}
            Write-Host 'Waiting for active jobs...'
            Start-Sleep -Seconds 2
        }while($true)
        $current=Get-Server
        if(!$current -or $current.ProcessId -ne $server.ProcessId -or $current.CreationDate -ne $server.CreationDate){throw 'Server identity changed; refusing to stop.'}
        $process=Get-Process -Id $server.ProcessId
        $null=Invoke-RestMethod "$url/api/shutdown" -Method Post -TimeoutSec 5
        if(!$process.WaitForExit(10000)){
            $current=Get-CimInstance Win32_Process -Filter "ProcessId = $($server.ProcessId)"
            if($current -and $current.CreationDate -ne $server.CreationDate){throw 'Server identity changed; refusing to stop.'}
            if($current){
                Stop-Process -Id $server.ProcessId
                Wait-Process -Id $server.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        Write-Host 'Stack stopped. Remote worker processes were left running.'
    }
}finally{$lock.Dispose()}
