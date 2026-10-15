# Install dsh-model-fallback into a DSH desktop profile.
#
# Usage:
#   pwsh -File .\install\install.ps1
#   pwsh -File .\install\install.ps1 -ProfilePath <profile path>
#
# Must be a REAL DIRECTORY copy: the desktop host refuses to start when the
# profile tree contains a symlink or junction it did not create itself
# (PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available).
#
# The bundle entry makes the package's own `cordis.patch.yml` apply
# automatically, so nothing is added to the profile's cordis.patch.yml
# (adding it twice yields `duplicate loader entry id`).
#
# The default `-ProfilePath` follows the same rule the plugin itself uses to find
# its data directory (`lib/store.js`: `$DSH_HOME` else `~/.dsh`), so it works for
# a portable or relocated install as well as a default one. Pass `-ProfilePath`
# explicitly if yours differs.

[CmdletBinding()]
param(
  [string]$ProfilePath = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'profiles\desktop'),
  [string]$PackageName = 'dsh-model-fallback'
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot          # the package root
$pkgJson = Join-Path $ProfilePath 'package.json'
$dest = Join-Path $ProfilePath "node_modules\$PackageName"

if (-not (Test-Path $pkgJson)) { throw "profile package.json not found: $pkgJson" }

# 1. Copy the package as a real directory (never a link/junction).
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
foreach ($item in @('package.json', 'cordis.patch.yml', 'README.md', 'lib', 'test', 'install')) {
  $from = Join-Path $src $item
  if (-not (Test-Path $from)) { continue }
  Copy-Item $from $dest -Recurse -Force
}
Write-Host "[install] copied package -> $dest"

# 2. Declare the dependency and the bundle entry.
$raw = Get-Content $pkgJson -Raw
$json = $raw | ConvertFrom-Json
$version = (Get-Content (Join-Path $src 'package.json') -Raw | ConvertFrom-Json).version

if ($json.dependencies.PSObject.Properties.Name -notcontains $PackageName) {
  $json.dependencies | Add-Member -NotePropertyName $PackageName -NotePropertyValue $version
  Write-Host "[install] added dependency $PackageName@$version"
}

$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains $PackageName) {
  $json.dsh.profile.bundles = @($bundles + $PackageName)
  Write-Host "[install] appended bundle entry $PackageName"
}

$json | ConvertTo-Json -Depth 10 | Set-Content -Path $pkgJson -Encoding UTF8
Write-Host "[install] done. Restart DSH to load the plugin."
