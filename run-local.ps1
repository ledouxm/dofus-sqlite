#Requires -Version 5.1
<#
.SYNOPSIS
    Run the dofus-sqlite pipeline locally, mirroring the GitHub Actions dev.yaml workflow.

.PARAMETER SkipDownload
    Skip the cytrus-v6 download step (reuse existing parser/temp/ files).

.PARAMETER SkipParse
    Skip the JSON parsing step (reuse existing parser/json/ files).

.PARAMETER SkipDatabase
    Skip the SQLite database generation step.

.PARAMETER SkipProto
    Skip the Il2CppDumper + protodec step.

.PARAMETER CreateRelease
    Create a GitHub release after processing (requires gh CLI and GH_TOKEN).

.PARAMETER ReleaseTag
    Custom suffix for the release tag (e.g. "test" -> "VERSION-test-dev-TIMESTAMP").

.EXAMPLE
    .\run-local.ps1
    # Full pipeline

.EXAMPLE
    .\run-local.ps1 -SkipDownload
    # Use existing temp/ files, re-parse and regenerate DB

.EXAMPLE
    .\run-local.ps1 -SkipDownload -SkipParse
    # Use existing json/ files, only regenerate DB

.EXAMPLE
    .\run-local.ps1 -SkipDownload -SkipParse -SkipDatabase -SkipProto
    # Dry run — check prerequisites only
#>
param(
    [switch]$SkipDownload,
    [switch]$SkipParse,
    [switch]$SkipDatabase,
    [switch]$SkipProto,
    [switch]$CreateRelease,
    [string]$ReleaseTag = ""
)

$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot

function Write-Step {
    param([string]$Name)
    Write-Host "`n==> $Name" -ForegroundColor Cyan
}

function Write-Skip {
    param([string]$Name)
    Write-Host "--- SKIPPED: $Name" -ForegroundColor DarkGray
}

function Assert-Command {
    param([string]$Cmd, [string]$InstallHint)
    if (-not (Get-Command $Cmd -ErrorAction SilentlyContinue)) {
        Write-Host "ERROR: '$Cmd' not found. $InstallHint" -ForegroundColor Red
        exit 1
    }
}

# ── Prerequisites ─────────────────────────────────────────────────────────────
Write-Step "Checking prerequisites"

Assert-Command "dotnet"   "Install .NET SDK from https://dotnet.microsoft.com/download"
Assert-Command "pnpm"     "Install pnpm: npm i -g pnpm"
Assert-Command "cytrus-v6" "Install cytrus: npm i -g cytrus-v6"

if ($CreateRelease) {
    Assert-Command "gh" "Install GitHub CLI from https://cli.github.com"
}

Write-Host "All prerequisites met." -ForegroundColor Green

# ── Install parser dependencies ───────────────────────────────────────────────
Write-Step "Installing parser dependencies"
Push-Location "$ScriptRoot\parser"
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
} finally {
    Pop-Location
}

# ── Download game files ───────────────────────────────────────────────────────
if ($SkipDownload) {
    Write-Skip "cytrus-v6 download"
} else {
    Write-Step "Downloading game files with cytrus-v6"
    Push-Location "$ScriptRoot\parser"
    try {
        cytrus-v6 download --game dofus --release dofus3 --output temp/ `
            --select "**/StreamingAssets/Content/Data/**/*.bundle" `
            --select "**/StreamingAssets/Content/I18n/*.bin" `
            --select "**/StreamingAssets/Content/Map/Data/**/*.bundle" `
            --select "**/GameAssembly.dll" `
            --select "**/global-metadata.dat"
        if ($LASTEXITCODE -ne 0) { throw "cytrus-v6 download failed" }
    } finally {
        Pop-Location
    }
}

# ── Parse bundles to JSON ─────────────────────────────────────────────────────
if ($SkipParse) {
    Write-Skip "Bundle parsing (pnpm extract)"
} else {
    Write-Step "Parsing bundles to JSON"
    Push-Location "$ScriptRoot\parser"
    try {
        $env:INPUT_FOLDER = "temp/"
        $env:OUTPUT_FOLDER = "json/"
        pnpm extract
        if ($LASTEXITCODE -ne 0) { throw "pnpm extract failed" }
    } finally {
        Remove-Item Env:\INPUT_FOLDER -ErrorAction SilentlyContinue
        Remove-Item Env:\OUTPUT_FOLDER -ErrorAction SilentlyContinue
        Pop-Location
    }
}

# ── Generate SQLite database ──────────────────────────────────────────────────
if ($SkipDatabase) {
    Write-Skip "Database generation (pnpm db)"
} else {
    Write-Step "Generating SQLite database"
    Push-Location "$ScriptRoot\parser"
    try {
        $env:DATABASE_URL = "./dofus.sqlite"
        $env:JSON_FOLDER = "json/"
        pnpm db
        if ($LASTEXITCODE -ne 0) { throw "pnpm db failed" }
    } finally {
        Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
        Remove-Item Env:\JSON_FOLDER -ErrorAction SilentlyContinue
        Pop-Location
    }
}

# ── Il2CppDumper + protodec ───────────────────────────────────────────────────
if ($SkipProto) {
    Write-Skip "Il2CppDumper + protodec"
} else {
    Write-Step "Running Il2CppDumper"
    & "$ScriptRoot\Il2CppDumper\Il2CppDumper.exe" `
        "$ScriptRoot\parser\temp\GameAssembly.dll" `
        "$ScriptRoot\parser\temp\Dofus_Data\il2cpp_data\Metadata\global-metadata.dat"
    if ($LASTEXITCODE -ne 0) { throw "Il2CppDumper failed" }

    Write-Step "Running protodec"
    & "$ScriptRoot\Il2CppDumper\protodec.exe" `
        "$ScriptRoot\Il2CppDumper\DummyDll" `
        "$ScriptRoot\parser\dofus.proto" `
        --include-properties-without-non-user-code-attribute
    if ($LASTEXITCODE -ne 0) { throw "protodec failed" }
}

# ── Create GitHub Release (optional) ─────────────────────────────────────────
if ($CreateRelease) {
    Write-Step "Creating GitHub release"

    $version = cytrus-v6 version --game dofus --release dofus3
    $timestamp = Get-Date -Format "yyyyMMddHHmmss"
    $tag = if ($ReleaseTag) { "$version-$ReleaseTag-dev-$timestamp" } else { "$version-dev-$timestamp" }

    $notes = "Quick links:`n"
    $notes += "  - [dofus.sqlite](https://github.com/ledouxm/dofus-sqlite/releases/download/v$tag/dofus.sqlite)`n"
    $notes += "  - [dofus.proto](https://github.com/ledouxm/dofus-sqlite/releases/download/v$tag/dofus.proto)`n`n"
    $notes += "Release contains:`n`n"
    $notes += "- dofus.sqlite database file`n"
    $notes += "- i18n files`n"
    $notes += "- Dofus 3 data files`n"
    $notes += "- Dofus obfuscated proto file`n`n"
    $notes += "This release was generated locally."

    gh release create "v$tag" --title "Dev Release $tag" --notes $notes --draft=true --prerelease
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }

    $files = Get-ChildItem -Path "$ScriptRoot\parser\json" -File
    foreach ($file in $files) {
        gh release upload "v$tag" $file.FullName
    }
    gh release upload "v$tag" "$ScriptRoot\parser\dofus.sqlite"
    gh release upload "v$tag" "$ScriptRoot\parser\dofus.proto"
    if ($LASTEXITCODE -ne 0) { throw "gh release upload failed" }

    Write-Host "`nRelease created: v$tag" -ForegroundColor Green
} else {
    Write-Skip "GitHub release (pass -CreateRelease to enable)"
}

Write-Host "`nDone!" -ForegroundColor Green
