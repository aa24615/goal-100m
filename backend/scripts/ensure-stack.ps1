<#
.SYNOPSIS
  mm8888 stack watchdog: heal the whole chain (Docker daemon -> containers -> HTTP health).

.DESCRIPTION
  Why this exists:
    On 2026-11-03 20:48 the backend shut down gracefully and never came back for 4h12m
    (no app log at all until the daemon was started manually on 11-04 01:00).
    docker-compose 'restart: always' only works WHILE the Docker daemon runs; it cannot
    resurrect the daemon itself. A stopped stack produces ZERO application logs, so the
    outage is invisible in the very log files we analyze.

  What it does (idempotent, safe to run on a schedule):
    1) GET the health endpoint; if 200 -> log OK and exit 0 (no side effects).
    2) Otherwise check the Docker daemon; if down -> start Docker Desktop and wait.
    3) Run 'docker-compose up -d' (NO --build, so untested work-in-progress sources
       in the workspace are never pushed to production by this script).
    4) Poll health again, then log the outcome.

  NOTE: This script does NOT register itself as a scheduled task (that would modify
  OS state without the operator's consent). See docs for the one-line registration.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File backend\scripts\ensure-stack.ps1
#>
param(
  [string]$HealthUrl = "http://localhost:8080/api/health",
  [string]$ComposeDir = "D:\www\nas-claw\mm8888",
  [string]$LogFile = "D:\www\nas-claw\mm8888\backend\logs\stack-watch.log",
  [string]$DockerBin = "C:\Program Files\Docker\Docker\resources\bin",
  [string]$DesktopExe = "C:\Program Files\Docker\Docker\Docker Desktop.exe",
  [int]$HealthTimeoutSec = 5,
  [int]$DesktopWaitSec = 180,
  [int]$HealthWaitSec = 120,
  [switch]$NoDesktopStart
)

$ErrorActionPreference = "Continue"
if ($env:PATH -notlike "*Docker*") { $env:PATH = $env:PATH + ";" + $DockerBin }

function Write-Log($msg) {
  $line = "{0} {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $msg
  try {
    $dir = Split-Path -Parent $LogFile
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    Add-Content -Path $LogFile -Value $line -Encoding utf8
  } catch { }
  Write-Output $line
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec $HealthTimeoutSec
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Test-Daemon {
  try {
    $out = & docker info 2>&1
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

# ---- 1. fast path: healthy, do nothing ------------------------------------
if (Test-Health) {
  Write-Log "OK health=200 (no action)"
  exit 0
}
Write-Log "WARN health check failed -> start healing"

# ---- 2. daemon layer -------------------------------------------------------
if (-not (Test-Daemon)) {
  if ($NoDesktopStart) {
    Write-Log "ABORT daemon down and -NoDesktopStart specified"
    exit 2
  }
  if (-not (Test-Path $DesktopExe)) {
    Write-Log "ABORT Docker Desktop not found at $DesktopExe"
    exit 3
  }
  Write-Log "INFO starting Docker Desktop"
  Start-Process -FilePath $DesktopExe | Out-Null

  $deadline = (Get-Date).AddSeconds($DesktopWaitSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    if (Test-Daemon) { Write-Log "INFO daemon ready"; break }
  }
  if (-not (Test-Daemon)) {
    Write-Log "ABORT daemon not ready after ${DesktopWaitSec}s"
    exit 4
  }
} else {
  Write-Log "INFO daemon already up"
}

# ---- 3. container layer (never --build) ------------------------------------
Push-Location $ComposeDir
try {
  Write-Log "INFO docker-compose up -d (no --build)"
  $up = & docker-compose up -d 2>&1
  Write-Log ("INFO compose: " + ($up -join " | "))
} catch {
  Write-Log ("WARN compose failed: " + $_.Exception.Message)
} finally {
  Pop-Location
}

# ---- 4. wait for health ----------------------------------------------------
$deadline = (Get-Date).AddSeconds($HealthWaitSec)
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 5
  if (Test-Health) {
    Write-Log "OK recovered health=200"
    exit 0
  }
}
Write-Log "FAIL still unhealthy after ${HealthWaitSec}s"
exit 5
