[CmdletBinding()]
param(
    [string]$Python,
    [switch]$SkipPaddle,
    [switch]$SkipPlugin
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$venv = Join-Path $repoRoot '.venv'

function Find-PythonLauncher {
    if ($Python) {
        return @{ File = $Python; Args = @() }
    }

    $candidates = @(
        @{ File = 'py'; Args = @('-3.11') },
        @{ File = 'py'; Args = @('-3.10') },
        @{ File = 'py'; Args = @('-3.12') },
        @{ File = 'python'; Args = @() },
        @{ File = 'python3'; Args = @() }
    )
    foreach ($candidate in $candidates) {
        try {
            & $candidate.File @($candidate.Args) -c "import sys; raise SystemExit(0 if (3, 10) <= sys.version_info[:2] < (3, 13) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) {
                return $candidate
            }
        }
        catch {
            continue
        }
    }
    throw 'Python 3.10, 3.11, or 3.12 was not found. Install 64-bit Python and rerun this script.'
}

$launcher = Find-PythonLauncher
if (-not (Test-Path -LiteralPath $venv -PathType Container)) {
    Write-Host "Creating virtual environment at $venv"
    & $launcher.File @($launcher.Args) -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create the Python virtual environment.' }
}

$venvPython = Join-Path $venv 'Scripts\python.exe'
& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Failed to upgrade pip.' }

$extra = if ($SkipPaddle) { 'test' } else { 'ocr,test' }
& $venvPython -m pip install -e "$repoRoot\ocr-service[$extra]"
if ($LASTEXITCODE -ne 0) { throw 'Failed to install OCR service dependencies.' }

if (-not $SkipPlugin) {
    Enable-NodeForPnpm
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        Write-Warning 'pnpm is not on PATH; the OCR service is installed, but the Harness plugin was not built.'
        Write-Warning 'Install Node.js 22.19+ or 24+ and pnpm 11, then run .\scripts\install-plugin.ps1.'
    }
    else {
        & (Join-Path $PSScriptRoot 'install-plugin.ps1') -BuildOnly
    }
}

Write-Host 'Installation complete.'
