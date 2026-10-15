# Rollback dsh-model-fallback from a DSH desktop profile.
#
# Usage:
#   pwsh -File .\install\uninstall.ps1
#   pwsh -File .\install\uninstall.ps1 -ProfilePath <profile path>
#
# Removes the dependency line, the bundle entry and the package directory.
# Idempotent: safe to run when nothing is installed.

# Same default rule as install.ps1: `$DSH_HOME` else `~/.dsh`.

[CmdletBinding()]
param(
  [string]$ProfilePath = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'profiles\desktop'),
  [string]$PackageName = 'dsh-model-fallback'
)

$ErrorActionPreference = 'Stop'
$pkgJson = Join-Path $ProfilePath 'package.json'
$target = Join-Path $ProfilePath "node_modules\$PackageName"

if (-not (Test-Path $pkgJson)) { throw "profile package.json not found: $pkgJson" }

# Rewrite package.json from its JSON form so the edit cannot corrupt formatting.
$raw = Get-Content $pkgJson -Raw
$json = $raw | ConvertFrom-Json

if ($json.dependencies.PSObject.Properties.Name -contains $PackageName) {
  $json.dependencies.PSObject.Properties.Remove($PackageName)
  Write-Host "[uninstall] removed dependency $PackageName"
}

$bundles = @($json.dsh.profile.bundles)
if ($bundles -contains $PackageName) {
  $json.dsh.profile.bundles = @($bundles | Where-Object { $_ -ne $PackageName })
  Write-Host "[uninstall] removed bundle entry $PackageName"
}

$json | ConvertTo-Json -Depth 10 | Set-Content -Path $pkgJson -Encoding UTF8

if (Test-Path $target) {
  Remove-Item -Recurse -Force $target
  Write-Host "[uninstall] removed $target"
}

Write-Host "[uninstall] done. Restart DSH to fully unload the plugin."
