# Re-enable dsh-model-fallback.
#
# Usage:
#   pwsh -File .\install\enable.ps1
#   pwsh -File .\install\enable.ps1 -DataDir <data dir>

[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'model-fallback')
)

$ErrorActionPreference = 'Stop'
Remove-Item (Join-Path $DataDir 'disable') -Force -ErrorAction SilentlyContinue
Write-Host "[kill-switch] plugin ENABLED."
