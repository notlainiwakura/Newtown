Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Import-DotEnv {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) {
      continue
    }

    $parts = $trimmed -split '=', 2
    if ($parts.Count -ne 2) {
      continue
    }

    $key = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [System.Environment]::SetEnvironmentVariable($key, $value, 'Process')
  }
}

function Resolve-Node {
  param([string]$Root)

  $candidates = @(
    $env:NEWTOWN_NODE,
    (Join-Path $Root '.tools\node22\node-v22.22.2-win-x64\node.exe'),
    (Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe')
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command -and $command.Source -and -not $command.Source.Contains('WindowsApps')) {
    return $command.Source
  }

  throw 'Could not find a usable node.exe. Set NEWTOWN_NODE or place Node 22 in .tools\node22.'
}

function Invoke-Node {
  param(
    [string]$NodeExe,
    [string[]]$Arguments,
    [string]$WorkingDirectory
  )

  & $NodeExe @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed: $NodeExe $($Arguments -join ' ')"
  }
}

function Merge-Environment {
  param(
    [hashtable]$Base,
    [hashtable]$Override
  )

  $merged = @{}
  foreach ($key in $Base.Keys) {
    $merged[$key] = $Base[$key]
  }
  foreach ($key in $Override.Keys) {
    $merged[$key] = $Override[$key]
  }

  return $merged
}

function Start-LoggedProcess {
  param(
    [string]$Name,
    [string]$NodeExe,
    [string]$WorkingDirectory,
    [string[]]$Arguments,
    [string]$LogPath,
    [hashtable]$Environment
  )

  $baseName = [System.IO.Path]::GetFileNameWithoutExtension($LogPath)
  $outLog = Join-Path ([System.IO.Path]::GetDirectoryName($LogPath)) "$baseName.out.log"
  $errLog = Join-Path ([System.IO.Path]::GetDirectoryName($LogPath)) "$baseName.err.log"
  foreach ($path in @($outLog, $errLog)) {
    if (Test-Path -LiteralPath $path) {
      Remove-Item -LiteralPath $path -Force
    }
  }

  $savedEnv = @{}
  foreach ($key in $Environment.Keys) {
    $savedEnv[$key] = [System.Environment]::GetEnvironmentVariable($key, 'Process')
    [System.Environment]::SetEnvironmentVariable($key, [string]$Environment[$key], 'Process')
  }

  try {
    $process = Start-Process -FilePath $NodeExe `
      -ArgumentList $Arguments `
      -WorkingDirectory $WorkingDirectory `
      -RedirectStandardOutput $outLog `
      -RedirectStandardError $errLog `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    foreach ($key in $savedEnv.Keys) {
      [System.Environment]::SetEnvironmentVariable($key, $savedEnv[$key], 'Process')
    }
  }

  if (-not $process) {
    throw "Failed to start $Name"
  }

  return $process
}

$root = $PSScriptRoot
Set-Location -LiteralPath $root
Import-DotEnv -Path (Join-Path $root '.env')

$nodeExe = Resolve-Node -Root $root
$newtownHome = if ($env:NEWTOWN_HOME) { $env:NEWTOWN_HOME } else { Join-Path $env:USERPROFILE '.newtown' }
$webHome = Join-Path $newtownHome 'guide'
$neoHome = Join-Path $newtownHome 'neo'
$platoHome = Join-Path $newtownHome 'plato'
$joeHome = Join-Path $newtownHome 'joe'
$logDir = Join-Path $newtownHome 'logs'
$pidFile = Join-Path $newtownHome 'pids.txt'
$webPort = if ($env:WEB_PORT) { [int]$env:WEB_PORT } else { 3000 }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Write-Host 'Stopping any running Newtown services...'
& powershell -ExecutionPolicy Bypass -File (Join-Path $root 'stop.ps1') | Out-Null

Write-Host 'Building Newtown...'
Invoke-Node -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('.\node_modules\typescript\bin\tsc')

Write-Host 'Bootstrapping isolated homes...'
Invoke-Node -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\scripts\bootstrap-town.js', '--home', $webHome, '--persona', 'guide')
Invoke-Node -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\scripts\bootstrap-town.js', '--home', $neoHome, '--persona', 'neo')
Invoke-Node -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\scripts\bootstrap-town.js', '--home', $platoHome, '--persona', 'plato')
Invoke-Node -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\scripts\bootstrap-town.js', '--home', $joeHome, '--persona', 'joe')

$sharedEnv = @{
  OPENAI_BASE_URL   = if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { 'http://192.168.68.69:8080/v1' }
  OPENAI_MODEL      = if ($env:OPENAI_MODEL) { $env:OPENAI_MODEL } else { 'MiniMax-M2.7' }
  OPENAI_API_KEY    = if ($env:OPENAI_API_KEY) { $env:OPENAI_API_KEY } else { 'not-needed' }
  POSSESSION_TOKEN  = if ($env:POSSESSION_TOKEN) { $env:POSSESSION_TOKEN } else { 'newtown' }
  CHARACTER_BASE_URL = if ($env:CHARACTER_BASE_URL) { $env:CHARACTER_BASE_URL } else { (if ($env:OPENAI_BASE_URL) { $env:OPENAI_BASE_URL } else { 'http://192.168.68.69:8080/v1' }) }
  CHARACTER_MODEL    = if ($env:CHARACTER_MODEL) { $env:CHARACTER_MODEL } else { (if ($env:OPENAI_MODEL) { $env:OPENAI_MODEL } else { 'MiniMax-M2.7' }) }
  CHARACTER_PROVIDER = if ($env:CHARACTER_PROVIDER) { $env:CHARACTER_PROVIDER } else { 'openai' }
}

$peerNeo = '[{"id":"plato","name":"Plato","url":"http://127.0.0.1:3004"},{"id":"joe","name":"Joe","url":"http://127.0.0.1:3005"}]'
$peerPlato = '[{"id":"neo","name":"Neo","url":"http://127.0.0.1:3003"},{"id":"joe","name":"Joe","url":"http://127.0.0.1:3005"}]'
$peerJoe = '[{"id":"neo","name":"Neo","url":"http://127.0.0.1:3003"},{"id":"plato","name":"Plato","url":"http://127.0.0.1:3004"}]'

Write-Host 'Starting services...'
$processes = @()
$processes += Start-LoggedProcess -Name 'web' -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\index.js', 'web', '--port', "$webPort") -LogPath (Join-Path $logDir 'web.log') -Environment (Merge-Environment -Base $sharedEnv -Override @{ LAIN_HOME = $webHome })
$processes += Start-LoggedProcess -Name 'gateway' -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\index.js', 'gateway') -LogPath (Join-Path $logDir 'gateway.log') -Environment (Merge-Environment -Base $sharedEnv -Override @{ LAIN_HOME = $webHome })
$processes += Start-LoggedProcess -Name 'neo' -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\index.js', 'neo', '--port', '3003') -LogPath (Join-Path $logDir 'neo.log') -Environment (Merge-Environment -Base $sharedEnv -Override @{ LAIN_HOME = $neoHome; PORT = '3003'; PEER_CONFIG = $peerNeo })
$processes += Start-LoggedProcess -Name 'plato' -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\index.js', 'plato', '--port', '3004') -LogPath (Join-Path $logDir 'plato.log') -Environment (Merge-Environment -Base $sharedEnv -Override @{ LAIN_HOME = $platoHome; PORT = '3004'; PEER_CONFIG = $peerPlato })
$processes += Start-LoggedProcess -Name 'joe' -NodeExe $nodeExe -WorkingDirectory $root -Arguments @('dist\index.js', 'joe', '--port', '3005') -LogPath (Join-Path $logDir 'joe.log') -Environment (Merge-Environment -Base $sharedEnv -Override @{ LAIN_HOME = $joeHome; PORT = '3005'; PEER_CONFIG = $peerJoe })

Start-Sleep -Seconds 5

foreach ($process in $processes) {
  if ($process.HasExited) {
    throw "A service exited during startup. Check logs in $logDir"
  }
}

Set-Content -LiteralPath $pidFile -Value ([string](($processes | ForEach-Object { $_.Id }) -join ' '))
Write-Host "Newtown is running at http://localhost:$webPort"
Write-Host 'Resident links: /neo/ /plato/ /joe/'
Write-Host "Logs: $logDir"
