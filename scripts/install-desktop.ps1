$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$node = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
$npm = Get-Command npm.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $node -or -not $npm) {
    throw 'Install Node.js 24 or newer with npm, then open a new PowerShell window.'
}
$nodeVersion = & $node.Source -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^\d+\.\d+\.\d+$' -or [version]$nodeVersion -lt [version]'24.0.0') {
    throw "Node.js 24 or newer is required. Found: $nodeVersion"
}

$codex = Get-Command codex.exe, codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $codex) {
    throw 'Install the Codex CLI or add it to PATH, then open a new PowerShell window.'
}
& $codex.Source plugin marketplace add --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'Update the Codex CLI to a version that supports codex plugin marketplace add.'
}

$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & $npm.Source ci --include=dev
    if ($LASTEXITCODE -ne 0) { throw 'Could not install npm dependencies. See the npm error above.' }

    & $npm.Source run package:desktop
    if ($LASTEXITCODE -ne 0) { throw 'Could not build the Desktop plugin. See the build error above.' }

    $marketplace = Join-Path $projectRoot 'dist\desktop-marketplace'
    & $codex.Source plugin marketplace add $marketplace
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the local marketplace. See the Codex error above.' }

    & $codex.Source plugin add 'local-trajectory-viewer@local-trajectory'
    if ($LASTEXITCODE -ne 0) { throw 'Could not install the Desktop plugin. See the Codex error above.' }
} finally {
    Pop-Location
}

Write-Output 'Complete. Fully quit and relaunch Codex Desktop to load the plugin.'
