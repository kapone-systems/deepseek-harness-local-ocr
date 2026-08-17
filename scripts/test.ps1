[CmdletBinding()]
param(
    [switch]$PaddleIntegration
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Import-LocalOcrEnv
$python = Get-VenvPython

if ($PaddleIntegration) {
    $env:RUN_PADDLE_OCR_TESTS = '1'
}
& $python -m pytest "$script:RepoRoot\ocr-service\tests"
if ($LASTEXITCODE -ne 0) { throw 'OCR service tests failed.' }

Enable-NodeForPnpm
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if ($null -eq $pnpm) {
    throw 'pnpm is not on PATH; Harness plugin tests were not run.'
}
Push-Location (Join-Path $script:RepoRoot 'harness-plugin')
try {
    pnpm run typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Harness plugin typecheck failed.' }
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw 'Harness plugin tests failed.' }
    pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Harness plugin build failed.' }
}
finally {
    Pop-Location
}

Write-Host 'All local test suites passed.'
