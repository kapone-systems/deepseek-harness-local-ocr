[CmdletBinding()]
param(
    [string]$ImagePath,
    [switch]$Matrix,
    [ValidateRange(1, 32)][int]$Requests = 1
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

if ($Matrix) {
    $cases = @(
        @{ Name = 'english-1080p'; Path = (Join-Path $script:RepoRoot 'tests\fixtures\english-screenshot.png'); Fields = @{} },
        @{ Name = 'chinese-1080p'; Path = (Join-Path $script:RepoRoot 'tests\fixtures\chinese-screenshot.png'); Fields = @{} },
        @{ Name = 'complex-1080p'; Path = (Join-Path $script:RepoRoot 'tests\fixtures\benchmark-1080p.png'); Fields = @{} },
        @{ Name = 'region'; Path = (Join-Path $script:RepoRoot 'tests\fixtures\region-grid.png'); Fields = @{ x = 500; y = 0; width = 500; height = 600 } }
    )
    $matrixResults = foreach ($case in $cases) {
        $resolved = (Resolve-Path -LiteralPath $case.Path).Path
        for ($requestIndex = 1; $requestIndex -le $Requests; $requestIndex++) {
            $watch = [System.Diagnostics.Stopwatch]::StartNew()
            $result = Invoke-LocalOcrMultipart -Uri $ocrUri -ImagePath $resolved -Fields $case.Fields -Headers (Get-OcrHeaders) -TimeoutSeconds 180
            $watch.Stop()
            [pscustomobject]@{
                case = $case.Name
                request = $requestIndex
                phase = if ($requestIndex -eq 1) { 'cold_or_first' } else { 'warm' }
                image = $resolved
                width = $result.image.width
                height = $result.image.height
                blocks = @($result.blocks).Count
                service_elapsed_ms = $result.elapsed_ms
                round_trip_ms = $watch.ElapsedMilliseconds
            }
        }
    }
    $matrixResults | ConvertTo-Json -Depth 8
    return
}

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
