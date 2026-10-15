# Emergency: disable dsh-model-fallback without restarting DSH.
# The waterfall listener checks this file on every call.
#
# Usage:
#   pwsh -File .\install\disable.ps1
#   pwsh -File .\install\disable.ps1 -DataDir <data dir>
#
# Same default rule as lib/store.js: `$DSH_HOME` else `~/.dsh`, plus the
# plugin's own `model-fallback` subdirectory.

[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }) 'model-fallback')
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Set-Content (Join-Path $DataDir 'disable') 'off' -Encoding UTF8
Write-Host "[kill-switch] plugin DISABLED (takes effect on your next request)."
