[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Import-LocalOcrEnv

$python = Get-VenvPython
$serviceUri = Get-LocalOcrUri
$env:PYTHONUNBUFFERED = '1'

Write-Host "Starting local OCR service at $($serviceUri.GetLeftPart([System.UriPartial]::Authority))"
Write-Host 'Press Ctrl+C to stop.'
Push-Location $script:RepoRoot
try {
    & $python -m uvicorn local_ocr_service.app:app --app-dir "$script:RepoRoot\ocr-service\src" --host 127.0.0.1 --port $serviceUri.Port
}
finally {
    Pop-Location
}
