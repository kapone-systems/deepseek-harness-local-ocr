[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Import-LocalOcrEnv

$serviceUri = Get-LocalOcrUri
$healthUri = [Uri]::new($serviceUri, '/health')
$response = Invoke-RestMethod -Method Get -Uri $healthUri -Headers (Get-OcrHeaders) -TimeoutSec 10
$response | ConvertTo-Json -Depth 8
