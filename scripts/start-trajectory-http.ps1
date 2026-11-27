$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$node = (Get-Command node.exe -ErrorAction Stop).Source
$entry = Join-Path $PSScriptRoot 'http-server.mjs'
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) {
    throw 'Run this script from the packaged Desktop plugin directory.'
}
$available = & $node $entry status 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Output $available
    exit 0
}
$worker = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '" start') -WindowStyle Hidden -PassThru
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $available = & $node $entry status 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Output $available
        exit 0
    }
    if ($worker.HasExited) {
        throw 'The HTTP MCP backend exited before becoming ready. Run node http-server.mjs start to see the error.'
    }
    Start-Sleep -Milliseconds 100
}
throw 'The HTTP MCP backend is still starting. Check it with node http-server.mjs status.'
