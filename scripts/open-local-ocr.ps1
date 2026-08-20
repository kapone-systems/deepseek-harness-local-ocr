[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$logDirectory = Join-Path $repoRoot 'logs'
$null = New-Item -ItemType Directory -Force -Path $logDirectory
$ocrLog = Join-Path $logDirectory 'shortcut-ocr-service.log'
$ocrErrorLog = Join-Path $logDirectory 'shortcut-ocr-service-error.log'
$harnessLog = Join-Path $logDirectory 'shortcut-harness.log'
$harnessErrorLog = Join-Path $logDirectory 'shortcut-harness-error.log'

function Get-PowerShellExecutable {
    $windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) {
        return $windowsPowerShell
    }

    $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue
    if ($null -ne $pwsh) {
        return $pwsh.Source
    }
    throw 'PowerShell executable was not found.'
}

function Test-LocalHttp {
    param([Parameter(Mandatory)][string]$Uri)

    try {
        $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri $Uri
        return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
    }
    catch {
        return $false
    }
}

function Start-ProjectScript {
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [string[]]$ScriptArguments = @(),
        [Parameter(Mandatory)][string]$OutputLog,
        [Parameter(Mandatory)][string]$ErrorLog
    )

    $shell = Get-PowerShellExecutable
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath
    if ($ScriptArguments.Count -gt 0) {
        $arguments += ' ' + ($ScriptArguments -join ' ')
    }
    Start-Process -FilePath $shell -WorkingDirectory $repoRoot -WindowStyle Hidden `
        -ArgumentList $arguments -RedirectStandardOutput $OutputLog -RedirectStandardError $ErrorLog | Out-Null
}

function Wait-ForLocalHttp {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$ServiceName
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-LocalHttp -Uri $Uri) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "$ServiceName did not start within ${TimeoutSeconds} seconds. Check the shortcut logs."
}

try {
    $ocrHealthUri = 'http://127.0.0.1:8765/health'
    if (-not (Test-LocalHttp -Uri $ocrHealthUri)) {
        Start-ProjectScript `
            -ScriptPath (Join-Path $repoRoot 'scripts\start-ocr-service.ps1') `
            -ScriptArguments @() `
            -OutputLog $ocrLog `
            -ErrorLog $ocrErrorLog
        Wait-ForLocalHttp -Uri $ocrHealthUri -TimeoutSeconds 90 -ServiceName 'OCR service'
    }

    $harnessUri = 'http://127.0.0.1:3081/'
    if (-not (Test-LocalHttp -Uri $harnessUri)) {
        Start-ProjectScript `
            -ScriptPath (Join-Path $repoRoot 'scripts\start-harness-local-ocr.ps1') `
            -ScriptArguments @('-Profile', 'local-ocr', '-Port', '3081') `
            -OutputLog $harnessLog `
            -ErrorLog $harnessErrorLog
        Wait-ForLocalHttp -Uri $harnessUri -TimeoutSeconds 120 -ServiceName 'Harness Web'
    }

    Start-Process $harnessUri
}
catch {
    $message = "DeepSeek Harness Local OCR failed: $($_.Exception.Message)`n`nLogs: $logDirectory"
    Add-Content -LiteralPath (Join-Path $logDirectory 'shortcut-launcher-error.log') -Value ("$(Get-Date -Format o) $message")
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($message, 'DeepSeek Harness Local OCR', 'OK', 'Error') | Out-Null
    }
    catch {
        Write-Error $message
    }
    exit 1
}
