[CmdletBinding()]
param(
    [string]$Profile = 'local-ocr',
    [string]$DshHome = '',
    [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$pluginRoot = Join-Path $repoRoot 'harness-plugin'

if (-not (Test-Path -LiteralPath (Join-Path $pluginRoot 'package.json') -PathType Leaf)) {
    throw "Harness plugin package is missing at $pluginRoot"
}
Enable-NodeForPnpm
if ($null -eq (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is not available. Install pnpm 11 or set HARNESS_RUNTIME_DIR to a Harness runtime directory.'
}

Push-Location $pluginRoot
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed.' }
    pnpm run build
    if ($LASTEXITCODE -ne 0) { throw 'Harness plugin build failed.' }
}
finally {
    Pop-Location
}

if ($BuildOnly) {
    Write-Host 'Harness plugin build complete.'
    exit 0
}

if ($Profile -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') {
    throw 'Profile must contain only letters, numbers, dots, underscores, and hyphens.'
}

if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'Process')
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    $DshHome = [Environment]::GetEnvironmentVariable('DSH_HOME', 'User')
}
if ([string]::IsNullOrWhiteSpace($DshHome)) {
    # Keep this project and its profile on the data drive by default.
    $DshHome = 'D:\\.dsh'
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$env:DSH_HOME = $DshHome

function Invoke-DshPlugin {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # Do not use a globally installed dsh here. The existing desktop launcher
    # can be an older release and would load a different profile home.
    pnpm dlx --package '@deepseek-ai/dsh@0.1.0-rc.6' dsh @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'DeepSeek Harness plugin command failed.' }
}

function Ensure-ProfileWebBundle {
    param([Parameter(Mandatory)][string]$ProfileDirectory)

    $manifestPath = Join-Path $ProfileDirectory 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Harness profile manifest is missing: $manifestPath"
    }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json -AsHashtable
    if ($null -eq $manifest['dsh']) { $manifest['dsh'] = @{} }
    if ($null -eq $manifest['dsh']['profile']) { $manifest['dsh']['profile'] = @{} }

    $existingBundles = @($manifest['dsh']['profile']['bundles'])
    $bundles = [System.Collections.Generic.List[string]]::new()
    foreach ($bundle in $existingBundles) {
        if (-not [string]::IsNullOrWhiteSpace([string]$bundle) -and $bundle -ne '@deepseek-ai/dsh-web-app') {
            $bundles.Add([string]$bundle)
        }
    }
    if (-not $bundles.Contains('@deepseek-ai/dsh-base')) {
        $bundles.Insert(0, '@deepseek-ai/dsh-base')
    }
    $baseIndex = $bundles.IndexOf('@deepseek-ai/dsh-base')
    $bundles.Insert($baseIndex + 1, '@deepseek-ai/dsh-web-app')
    $manifest['dsh']['profile']['bundles'] = @($bundles)

    $json = $manifest | ConvertTo-Json -Depth 16
    Set-Content -LiteralPath $manifestPath -Value $json -Encoding utf8
}

# Harness rc.6 forwards plugin arguments through cmd.exe on Windows. First
# initialize the profile, then use a profile-local junction and a no-space
# relative link spec so source paths containing spaces remain valid.
Invoke-DshPlugin -Arguments @('plugin', '--profile', $Profile, 'install')

$profileDirectory = Join-Path (Join-Path $DshHome 'profiles') $Profile
if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
    throw "Harness did not create the expected profile directory: $profileDirectory"
}
Ensure-ProfileWebBundle -ProfileDirectory $profileDirectory
$linkDirectory = Join-Path $profileDirectory 'plugins'
$null = New-Item -ItemType Directory -Force -Path $linkDirectory
$linkPath = Join-Path $linkDirectory 'dsh-plugin-local-ocr'

if (Test-Path -LiteralPath $linkPath) {
    $existingLink = Get-Item -LiteralPath $linkPath -Force
    if ($existingLink.LinkType -ne 'Junction') {
        throw "Refusing to replace the non-junction plugin path: $linkPath"
    }
    $actualTarget = [System.IO.Path]::GetFullPath([string]@($existingLink.Target)[0])
    $expectedTarget = [System.IO.Path]::GetFullPath($pluginRoot)
    if (-not [string]::Equals($actualTarget, $expectedTarget, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to replace a junction that targets a different plugin: $linkPath"
    }
}
else {
    $null = New-Item -ItemType Junction -Path $linkPath -Target $pluginRoot
}

Invoke-DshPlugin -Arguments @('plugin', '--profile', $Profile, 'add', 'link:plugins/dsh-plugin-local-ocr')
Ensure-ProfileWebBundle -ProfileDirectory $profileDirectory

Write-Host "Installed the local OCR bundle into Harness profile '$Profile' at '$DshHome'."
