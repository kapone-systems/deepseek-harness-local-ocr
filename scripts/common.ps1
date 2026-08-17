Set-StrictMode -Version Latest

$script:RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

function Import-LocalOcrEnv {
    param([string]$Path = (Join-Path $script:RepoRoot '.env'))

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return
    }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) {
            throw "Invalid .env line: $line"
        }
        $name = $trimmed.Substring(0, $separator).Trim()
        if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
            throw "Invalid .env variable name: $name"
        }
        if ($null -ne [Environment]::GetEnvironmentVariable($name, 'Process')) {
            continue
        }
        $value = $trimmed.Substring($separator + 1).Trim()
        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
                $value = $value.Substring(1, $value.Length - 2)
            }
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

function Get-LocalOcrUri {
    $raw = [Environment]::GetEnvironmentVariable('OCR_SERVICE_URL', 'Process')
    if ([string]::IsNullOrWhiteSpace($raw)) {
        $raw = 'http://127.0.0.1:8765'
    }
    try {
        $uri = [Uri]$raw
    }
    catch {
        throw "OCR_SERVICE_URL is not a valid URL: $raw"
    }
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.AbsolutePath -ne '/') {
        throw 'OCR_SERVICE_URL must be an http://127.0.0.1:<port> loopback URL with no path.'
    }
    if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
        throw 'OCR_SERVICE_URL must not contain a query string or fragment.'
    }
    return $uri
}

function Get-OcrHeaders {
    $headers = @{}
    $token = [Environment]::GetEnvironmentVariable('OCR_SERVICE_TOKEN', 'Process')
    if (-not [string]::IsNullOrEmpty($token)) {
        $headers.Authorization = "Bearer $token"
    }
    return $headers
}

function Get-LocalOcrImageMediaType {
    param([Parameter(Mandatory)][string]$Path)

    switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
        '.png' { return 'image/png' }
        '.jpg' { return 'image/jpeg' }
        '.jpeg' { return 'image/jpeg' }
        '.webp' { return 'image/webp' }
        default { throw 'Only .png, .jpg, .jpeg, and .webp files can be uploaded to local OCR.' }
    }
}

function Invoke-LocalOcrMultipart {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][Uri]$Uri,
        [Parameter(Mandatory)][string]$ImagePath,
        [hashtable]$Fields = @{},
        [hashtable]$Headers = @{},
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 120
    )

    $resolvedPath = (Resolve-Path -LiteralPath $ImagePath -ErrorAction Stop).Path
    $mediaType = Get-LocalOcrImageMediaType -Path $resolvedPath
    $handler = $null
    $client = $null
    $request = $null
    $response = $null
    try {
        $handler = [System.Net.Http.HttpClientHandler]::new()
        $client = [System.Net.Http.HttpClient]::new($handler)
        $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
        $multipart = [System.Net.Http.MultipartFormDataContent]::new()
        $fileStream = [System.IO.File]::OpenRead($resolvedPath)
        $fileContent = [System.Net.Http.StreamContent]::new($fileStream)
        $fileContent.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($mediaType)
        $multipart.Add($fileContent, 'file', [System.IO.Path]::GetFileName($resolvedPath))
        foreach ($entry in $Fields.GetEnumerator()) {
            $fieldContent = [System.Net.Http.StringContent]::new([string]$entry.Value, [Text.Encoding]::UTF8)
            $multipart.Add($fieldContent, [string]$entry.Key)
        }

        $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, $Uri)
        foreach ($entry in $Headers.GetEnumerator()) {
            [void]$request.Headers.TryAddWithoutValidation([string]$entry.Key, [string]$entry.Value)
        }
        $request.Content = $multipart
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) {
            throw "Local OCR request failed with HTTP $([int]$response.StatusCode): $body"
        }
        return $body | ConvertFrom-Json
    }
    finally {
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $request) { $request.Dispose() }
        if ($null -ne $client) { $client.Dispose() }
        if ($null -ne $handler) { $handler.Dispose() }
    }
}

function Get-VenvPython {
    $python = Join-Path $script:RepoRoot '.venv\Scripts\python.exe'
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        throw 'The project virtual environment is missing. Run .\scripts\install.ps1 first.'
    }
    return $python
}

function Set-PreferredPnpmCommand {
    param(
        [string]$PnpmDirectory = '',
        [string]$ExistingPath = ''
    )

    $commandPath = ''
    if (-not [string]::IsNullOrWhiteSpace($PnpmDirectory)) {
        $candidate = Join-Path $PnpmDirectory 'pnpm.cmd'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $commandPath = $candidate
        }
    }
    if ([string]::IsNullOrWhiteSpace($commandPath) -and
        -not [string]::IsNullOrWhiteSpace($ExistingPath) -and
        $ExistingPath.EndsWith('.ps1', [StringComparison]::OrdinalIgnoreCase)) {
        $candidate = [System.IO.Path]::ChangeExtension($ExistingPath, '.cmd')
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $commandPath = $candidate
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($commandPath)) {
        Set-Alias -Name pnpm -Value $commandPath -Scope Global -Force
    }
}

function Enable-NodeForPnpm {
    $node = Get-Command node -ErrorAction SilentlyContinue
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -ne $node -and $null -ne $pnpm) {
        Set-PreferredPnpmCommand -ExistingPath ([string]$pnpm.Source)
        return
    }

    # The D drive Harness installation includes a pinned Node/pnpm runtime.
    # Use it only when the user has not installed both tools globally. The
    # environment override keeps this project portable to a different install.
    $runtimeCandidates = [System.Collections.Generic.List[string]]::new()
    $configuredRuntime = [Environment]::GetEnvironmentVariable('HARNESS_RUNTIME_DIR', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($configuredRuntime)) {
        $runtimeCandidates.Add($configuredRuntime)
    }
    foreach ($runtime in @(
        'D:\\Program Files\\deepseek-harness\\runtime',
        'C:\\Program Files\\deepseek-harness\\runtime'
    )) {
        if (-not $runtimeCandidates.Contains($runtime)) {
            $runtimeCandidates.Add($runtime)
        }
    }

    foreach ($runtime in $runtimeCandidates) {
        $nodeDirectory = Join-Path $runtime 'node'
        $pnpmDirectory = Join-Path $runtime 'pnpm'
        $embeddedNode = Join-Path $nodeDirectory 'node.exe'
        $embeddedPnpm = Join-Path $pnpmDirectory 'pnpm.cmd'
        if ((Test-Path -LiteralPath $embeddedNode -PathType Leaf) -and
            (Test-Path -LiteralPath $embeddedPnpm -PathType Leaf)) {
            $env:Path = "$nodeDirectory$([System.IO.Path]::PathSeparator)$pnpmDirectory$([System.IO.Path]::PathSeparator)$env:Path"
            if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('PNPM_HOME', 'Process'))) {
                $env:PNPM_HOME = $pnpmDirectory
            }
            Set-PreferredPnpmCommand -PnpmDirectory $pnpmDirectory
            return
        }
    }

    # Codex's bundled pnpm has its matching Node runtime two levels above the
    # fallback wrapper. Preserve this path for development environments.
    if ($null -ne $pnpm) {
        $pnpmDirectory = Split-Path -Parent $pnpm.Source
        $dependenciesRoot = Split-Path -Parent (Split-Path -Parent $pnpmDirectory)
        $bundledNodeDirectory = Join-Path $dependenciesRoot 'node\bin'
        $bundledNode = Join-Path $bundledNodeDirectory 'node.exe'
        if (Test-Path -LiteralPath $bundledNode -PathType Leaf) {
            $env:Path = "$bundledNodeDirectory$([System.IO.Path]::PathSeparator)$env:Path"
            Set-PreferredPnpmCommand -ExistingPath ([string]$pnpm.Source)
            return
        }
    }

    throw 'Node.js and pnpm were not found. Install Node.js 22.19+ with pnpm, or set HARNESS_RUNTIME_DIR to a Harness runtime directory containing node\\node.exe and pnpm\\pnpm.cmd.'
}
