param(
  [Parameter(Mandatory = $true)][string]$Vault,
  [switch]$Watch
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $Vault '.obsidian\plugins\black-hole-graph'
$files = @('main.js', 'manifest.json', 'styles.css')

if (-not (Test-Path $Vault)) {
  throw "Vault not found: $Vault"
}
if (-not (Test-Path (Join-Path $root 'main.js'))) {
  throw "main.js not found. Run 'npm run build' first."
}

New-Item -ItemType Directory -Force -Path $target | Out-Null

function Copy-PluginFiles {
  foreach ($f in $files) {
    $src = Join-Path $root $f
    if (Test-Path $src) {
      Copy-Item -Force $src (Join-Path $target $f)
    }
  }
  Write-Host "Installed to $target"
}

Copy-PluginFiles

if ($Watch) {
  Write-Host "Watching main.js for changes. Ctrl+C to stop."
  $stamp = (Get-Item (Join-Path $root 'main.js')).LastWriteTimeUtc
  while ($true) {
    Start-Sleep -Milliseconds 700
    $now = (Get-Item (Join-Path $root 'main.js')).LastWriteTimeUtc
    if ($now -ne $stamp) {
      $stamp = $now
      Copy-PluginFiles
    }
  }
}
