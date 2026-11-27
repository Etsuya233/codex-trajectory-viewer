param([switch]$RemoveMarketplace)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

$codex = Get-Command codex.exe, codex.cmd -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $codex) {
    throw 'Install the Codex CLI or add it to PATH, then open a new PowerShell window.'
}

& $codex.Source plugin remove 'local-trajectory-viewer@local-trajectory'
if ($LASTEXITCODE -ne 0) { throw 'Could not uninstall the Desktop plugin. See the Codex error above.' }

if ($RemoveMarketplace) {
    & $codex.Source plugin marketplace remove 'local-trajectory'
    if ($LASTEXITCODE -ne 0) { throw 'The plugin was removed, but marketplace removal failed. See the Codex error above.' }
}

Write-Output 'Complete. Fully quit and relaunch Codex Desktop to refresh the plugin list.'
