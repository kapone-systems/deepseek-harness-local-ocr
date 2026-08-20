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
$profileDirectory = Join-Path (Join-Path $DshHome 'profiles') $Profile
$profileModulesYaml = Join-Path (Join-Path $profileDirectory 'node_modules') '.modules.yaml'
$profilePnpmStoreDir = Get-PnpmStoreDirFromModulesYaml -ModulesYamlPath $profileModulesYaml
$pluginModulesYaml = Join-Path (Join-Path $pluginRoot 'node_modules') '.modules.yaml'
$pluginPnpmStoreDir = Get-PnpmStoreDirFromModulesYaml -ModulesYamlPath $pluginModulesYaml

function Invoke-PnpmCommand {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [Parameter(Mandatory)][string]$FailureMessage,
        [string]$StoreDir = ''
    )

    $previousStoreDir = [Environment]::GetEnvironmentVariable('pnpm_config_store_dir', 'Process')
    $hadStoreDir = $null -ne $previousStoreDir
    try {
        if (-not [string]::IsNullOrWhiteSpace($StoreDir)) {
            # pnpm reads this lower-case config environment variable before
            # npm_config_store_dir. Scope it to this child process invocation.
            $env:pnpm_config_store_dir = $StoreDir
        }
        & pnpm @Arguments
        if ($LASTEXITCODE -ne 0) { throw $FailureMessage }
    }
    finally {
        if ($hadStoreDir) {
            $env:pnpm_config_store_dir = $previousStoreDir
        }
        else {
            Remove-Item Env:pnpm_config_store_dir -ErrorAction SilentlyContinue
        }
    }
}

Enable-NodeForPnpm
if ($null -eq (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    throw 'pnpm is not available. Install pnpm 11 or set HARNESS_RUNTIME_DIR to a Harness runtime directory.'
}

Push-Location $pluginRoot
try {
    Invoke-PnpmCommand -Arguments @('install') -FailureMessage 'pnpm install failed.' -StoreDir $pluginPnpmStoreDir
    Invoke-PnpmCommand -Arguments @('run', 'build') -FailureMessage 'Harness plugin build failed.' -StoreDir $pluginPnpmStoreDir
}
finally {
    Pop-Location
}

if ($BuildOnly) {
    Write-Host 'Harness plugin build complete.'
    exit 0
}

function Invoke-DshPlugin {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # Do not use a globally installed dsh here. The existing desktop launcher
    # can be an older release and would load a different profile home.
    $dshArguments = @('dlx', '--package', '@deepseek-ai/dsh@0.1.0-rc.6', 'dsh') + $Arguments
    Invoke-PnpmCommand -Arguments $dshArguments -FailureMessage 'DeepSeek Harness plugin command failed.' -StoreDir $profilePnpmStoreDir
}

function Ensure-ProfileWebBundle {
    param([Parameter(Mandatory)][string]$ProfileDirectory)

    $manifestPath = Join-Path $ProfileDirectory 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Harness profile manifest is missing: $manifestPath"
    }

    # Keep this compatible with PowerShell environments that do not expose
    # ConvertFrom-Json's hashtable switch (or redefine that command in a
    # user profile). The profile manifest is small and only needs object
    # properties here.
    $manifestText = Get-Content -LiteralPath $manifestPath -Raw -ErrorAction Stop
    $manifest = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $manifestText -ErrorAction Stop
    if ($null -eq $manifest.dsh) {
        $manifest | Add-Member -MemberType NoteProperty -Name dsh -Value ([pscustomobject]@{})
    }
    if ($null -eq $manifest.dsh.profile) {
        $manifest.dsh | Add-Member -MemberType NoteProperty -Name profile -Value ([pscustomobject]@{})
    }

    $existingBundles = @($manifest.dsh.profile.bundles)
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
    $manifest.dsh.profile.bundles = @($bundles)

    $json = Microsoft.PowerShell.Utility\ConvertTo-Json -InputObject $manifest -Depth 16
    Set-Content -LiteralPath $manifestPath -Value $json -Encoding utf8
}

function Remove-LegacyBridgeDefaultPatch {
    param([Parameter(Mandatory)][string]$ProfileDirectory)

    $patchPath = Join-Path $ProfileDirectory 'cordis.patch.yml'
    if (-not (Test-Path -LiteralPath $patchPath -PathType Leaf)) {
        return
    }

    $contents = Get-Content -LiteralPath $patchPath -Raw -ErrorAction Stop
    # V2 preview builds wrote this exact overlay into the user-owned profile.
    # Remove only that known entry; preserve any other profile customizations.
    $legacyEntry = '(?ms)^\s*- id:\s*agent-default-model\s*\r?\n\s+config:\s*\r?\n\s+provider:\s*deepseek-local-ocr\s*\r?\n\s+model:\s*deepseek-v4-flash\s*(?:\r?\n|$)'
    $updated = [regex]::Replace($contents, $legacyEntry, '')
    if ($updated -eq $contents) {
        return
    }

    $remainingEntries = @($updated -split '\r?\n' | Where-Object {
        $trimmed = $_.Trim()
        -not [string]::IsNullOrWhiteSpace($trimmed) -and -not $trimmed.StartsWith('#')
    })
    if ($remainingEntries.Count -eq 0) {
        $updated = "[]`r`n"
    }
    Set-Content -LiteralPath $patchPath -Value $updated -Encoding utf8
    Write-Host "Removed the legacy forced OCR model selection from profile '$Profile'."
}

# Harness rc.6 forwards plugin arguments through cmd.exe on Windows. First
# initialize the profile, then use a profile-local junction and a no-space
# relative link spec so source paths containing spaces remain valid.
Invoke-DshPlugin -Arguments @('plugin', '--profile', $Profile, 'install')

if (-not (Test-Path -LiteralPath $profileDirectory -PathType Container)) {
    throw "Harness did not create the expected profile directory: $profileDirectory"
}
Ensure-ProfileWebBundle -ProfileDirectory $profileDirectory
Remove-LegacyBridgeDefaultPatch -ProfileDirectory $profileDirectory
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
