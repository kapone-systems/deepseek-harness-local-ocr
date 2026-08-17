[CmdletBinding()]
param(
    [string]$ImagePath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Import-LocalOcrEnv

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'The benchmark script requires PowerShell 7 or newer for multipart -Form support.'
}
if (-not $ImagePath) {
    $ImagePath = Join-Path $script:RepoRoot 'tests\fixtures\benchmark-1080p.png'
}
$resolvedImage = (Resolve-Path -LiteralPath $ImagePath).Path
$serviceUri = Get-LocalOcrUri
$ocrUri = [Uri]::new($serviceUri, '/v1/ocr')

$process = $null
try {
    $listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $serviceUri.Port -State Listen -ErrorAction Stop |
        Select-Object -First 1
    if ($null -ne $listener) {
        $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    }
}
catch {
    Write-Warning 'Could not resolve the OCR service process; memory fields will be omitted.'
}

$beforeBytes = if ($null -eq $process) { $null } else { $process.WorkingSet64 }
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$response = Invoke-LocalOcrMultipart -Uri $ocrUri -ImagePath $resolvedImage -Headers (Get-OcrHeaders) -TimeoutSeconds 120
$stopwatch.Stop()

if ($null -ne $process) {
    $process.Refresh()
}
$afterBytes = if ($null -eq $process) { $null } else { $process.WorkingSet64 }
$peakBytes = if ($null -eq $process) { $null } else { $process.PeakWorkingSet64 }

[pscustomobject]@{
    image = $resolvedImage
    width = $response.image.width
    height = $response.image.height
    blocks = @($response.blocks).Count
    service_elapsed_ms = $response.elapsed_ms
    round_trip_ms = $stopwatch.ElapsedMilliseconds
    process_working_set_before_mb = if ($null -eq $beforeBytes) { $null } else { [math]::Round($beforeBytes / 1MB, 1) }
    process_working_set_after_mb = if ($null -eq $afterBytes) { $null } else { [math]::Round($afterBytes / 1MB, 1) }
    # PeakWorkingSet64 is process-lifetime peak, so restart the service for a clean run.
    process_peak_working_set_mb = if ($null -eq $peakBytes) { $null } else { [math]::Round($peakBytes / 1MB, 1) }
} | ConvertTo-Json
