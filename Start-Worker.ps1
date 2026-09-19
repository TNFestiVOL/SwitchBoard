$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:SWITCHBOARD_WORKER_TOKEN) {
    $secure = Import-Clixml -LiteralPath (Join-Path $PSScriptRoot 'worker-token.xml')
    $env:SWITCHBOARD_WORKER_TOKEN = [System.Net.NetworkCredential]::new('', $secure).Password
}
& npm.cmd run worker -- worker.config.json
