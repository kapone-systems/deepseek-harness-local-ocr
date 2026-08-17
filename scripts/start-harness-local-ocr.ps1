[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 3081,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')][string]$Profile = 'local-ocr',
    [string]$DshHome = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'common.ps1')
Import-LocalOcrEnv
Enable-NodeForPnpm

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'User')
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = 'D:\\.dsh'
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$env:DSH_HOME = $DshHome

$profileManifest = Join-Path (Join-Path (Join-Path $DshHome 'profiles') $Profile) 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
    throw "Harness profile '$Profile' is not installed at '$DshHome'. Run .\\scripts\\install-plugin.ps1 -Profile $Profile first."
}

$bundles = (Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json).dsh.profile.bundles
if (@($bundles) -notcontains '@deepseek-ai/dsh-web-app' -or @($bundles) -notcontains 'dsh-plugin-local-ocr') {
    throw "Harness profile '$Profile' does not contain the Web UI and local OCR bundles. Run .\\scripts\\install-plugin.ps1 -Profile $Profile first."
}

try {
    $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "$((Get-LocalOcrUri).GetLeftPart([System.UriPartial]::Authority))/health"
    if ($health.StatusCode -ne 200) { Write-Warning 'The local OCR service did not return HTTP 200. OCR calls will fail until it is started.' }
}
catch {
    Write-Warning 'The local OCR service is not reachable. Start .\\scripts\\start-ocr-service.ps1 in another PowerShell window before reading images.'
}

if ([string]::IsNullOrWhiteSpace($env:DSH_TELEMETRY_DISABLED)) {
    $env:DSH_TELEMETRY_DISABLED = '1'
}

Write-Host "Starting Harness local-ocr profile at http://127.0.0.1:$Port"
Write-Host 'Open that address in a browser. Press Ctrl+C to stop Harness.'
pnpm dlx --package '@deepseek-ai/dsh@0.1.0-rc.6' dsh --profile $Profile --port $Port
if ($LASTEXITCODE -ne 0) { throw 'DeepSeek Harness exited with an error.' }
