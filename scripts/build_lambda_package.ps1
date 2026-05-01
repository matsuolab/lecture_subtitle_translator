param(
    [string]$Python = 'python',
    [string]$OutputZip
)

$ErrorActionPreference = 'Stop'

$repoRoot = Convert-Path (Join-Path $PSScriptRoot '..')
if (-not $OutputZip) {
    $OutputZip = Join-Path $repoRoot 'dist\lambda\backend.zip'
}

$staging = Join-Path $repoRoot 'dist\lambda\staging'
$requirements = Join-Path $repoRoot 'backend\requirements.txt'

if (Test-Path -LiteralPath $staging) {
    Remove-Item -LiteralPath $staging -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $staging | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputZip) | Out-Null

& $Python -m pip install `
    --upgrade `
    --platform manylinux2014_x86_64 `
    --implementation cp `
    --python-version 3.13 `
    --only-binary=:all: `
    -r $requirements `
    -t $staging

Copy-Item -LiteralPath (Join-Path $repoRoot 'backend') -Destination $staging -Recurse

if (Test-Path -LiteralPath $OutputZip) {
    Remove-Item -LiteralPath $OutputZip -Force
}
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $OutputZip
Write-Host "Lambda package created: $OutputZip"
