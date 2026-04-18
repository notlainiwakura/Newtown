Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$envFile = Join-Path $root '.env'

if (Test-Path -LiteralPath $envFile) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }

    $parts = $trimmed -split '=', 2
    if ($parts.Count -eq 2 -and $parts[0].Trim() -eq 'NEWTOWN_HOME') {
      [System.Environment]::SetEnvironmentVariable('NEWTOWN_HOME', $parts[1].Trim().Trim('"').Trim("'"), 'Process')
    }
  }
}

$newtownHome = if ($env:NEWTOWN_HOME) { $env:NEWTOWN_HOME } else { Join-Path $env:USERPROFILE '.newtown' }
$pidFile = Join-Path $newtownHome 'pids.txt'

Write-Host 'Stopping Newtown services...'

if (-not (Test-Path -LiteralPath $pidFile)) {
  Write-Host 'No running services found.'
  exit 0
}

$pids = [regex]::Split((Get-Content -LiteralPath $pidFile -Raw).Trim(), '[,\s]+') | Where-Object { $_ }

foreach ($processId in $pids) {
  $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
  }
}

Start-Sleep -Seconds 2

foreach ($processId in $pids) {
  $process = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
  if ($process) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}

Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'All services stopped.'
