<#
.SYNOPSIS
    Deploy CRM v2 database to a PostgreSQL Docker container.

.DESCRIPTION
    Drops and recreates the target database, then runs SQL scripts 01-05 in
    order. Stops immediately on any SQL error and prints the full error output.

.EXAMPLE
    .\db_deploy.ps1
    .\db_deploy.ps1 -ContainerName crm-postgres -Database crm_v2
#>
param(
    [string]$Database      = "crm_v2",
    [string]$DbHost        = "localhost",
    [string]$Port          = "5433",
    [string]$User          = "sa",
    [string]$Password      = "Passw0rd",
    [string]$ContainerName = "crm-postgres",
    [string]$SeedPassword  = "Admin@12345"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptsDir = $PSScriptRoot

$SqlScripts = @(
    "01_init-db.sql",
    "02-seed-tenants-orgs-users.sql",
    "03-seed-leads-bulk.sql",
    "04-seed-interactions-followups.sql",
    "05-cleanup-seed-helpers.sql"
)

# ── Helpers ─────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host ">> $msg" -ForegroundColor Cyan
}

# Run a short inline SQL command against the container (e.g. DROP/CREATE DATABASE).
# Errors print naturally to the console; non-zero exit stops the script.
function Invoke-Sql {
    param([string]$Db, [string]$Sql, [string]$Label)
    Write-Host "   $Label ..." -NoNewline
    docker exec -e "PGPASSWORD=$Password" $ContainerName `
        psql -U $User -d $Db -c $Sql
    if ($LASTEXITCODE -ne 0) {
        Write-Host "   FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
    Write-Host "   [OK]" -ForegroundColor Green
}

# Copy a SQL file into the container and run it with psql -f.
# ON_ERROR_STOP=1 makes psql exit non-zero on the first SQL error and print
# the exact line and error message before stopping.
function Invoke-SqlFile {
    param([string]$Db, [string]$FilePath, [string]$Label)

    Write-Host ""
    Write-Host "   -- $Label" -ForegroundColor White

    # Random name to avoid collisions if two runs overlap
    $rand          = -join ((65..90) | Get-Random -Count 10 | ForEach-Object { [char]$_ })
    $containerPath = "/tmp/crm_deploy_$rand.sql"
    $tmpHost       = [System.IO.Path]::GetTempFileName()

    try {
        # Re-encode to UTF-8 without BOM (psql requires clean UTF-8)
        $content = [System.IO.File]::ReadAllText($FilePath, [System.Text.Encoding]::UTF8)
        [System.IO.File]::WriteAllText($tmpHost, $content, (New-Object System.Text.UTF8Encoding $false))

        docker cp $tmpHost "${ContainerName}:${containerPath}" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "   ERROR: docker cp to container failed" -ForegroundColor Red
            exit 1
        }

        # psql prints the error (file:line: ERROR: ...) then exits non-zero
        docker exec -e "PGPASSWORD=$Password" $ContainerName `
            psql -U $User -d $Db -v ON_ERROR_STOP=1 -f $containerPath

        $psqlExit = $LASTEXITCODE

        # Clean up temp file in container regardless of outcome
        docker exec $ContainerName rm -f $containerPath | Out-Null

        if ($psqlExit -ne 0) {
            Write-Host ""
            Write-Host "   FAILED: $Label exited with code $psqlExit" -ForegroundColor Red
            Write-Host "   (error details are printed above by psql)" -ForegroundColor Yellow
            exit $psqlExit
        }
    } finally {
        Remove-Item $tmpHost -Force -ErrorAction SilentlyContinue
    }

    Write-Host "   [OK] $Label" -ForegroundColor Green
}

# ── 1. Verify container is running ───────────────────────────────────────────
Write-Step "Checking container: $ContainerName"

$containerStatus = docker inspect --format "{{.State.Status}}" $ContainerName 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "   ERROR: Container '$ContainerName' not found. Is Docker running?" -ForegroundColor Red
    exit 1
}
if ($containerStatus.Trim() -ne "running") {
    Write-Host "   ERROR: Container '$ContainerName' is not running (status: $containerStatus)" -ForegroundColor Red
    exit 1
}
Write-Host "   Container is running [OK]" -ForegroundColor Green

# ── 2. Verify all SQL scripts are present ────────────────────────────────────
Write-Step "Verifying SQL scripts"

foreach ($f in $SqlScripts) {
    $p = Join-Path $ScriptsDir $f
    if (-not (Test-Path $p)) {
        Write-Host "   ERROR: Missing script: $p" -ForegroundColor Red
        exit 1
    }
    Write-Host "   Found: $f" -ForegroundColor Green
}

# ── 3. Drop & recreate database ──────────────────────────────────────────────
Write-Step "Recreating database: $Database"

Invoke-Sql -Db "postgres" `
    -Sql "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$Database' AND pid <> pg_backend_pid();" `
    -Label "Terminate active connections"

Invoke-Sql -Db "postgres" `
    -Sql "DROP DATABASE IF EXISTS $Database;" `
    -Label "Drop database"

Invoke-Sql -Db "postgres" `
    -Sql "CREATE DATABASE $Database;" `
    -Label "Create database"

# ── 4. Run scripts 01-05 in order ────────────────────────────────────────────
Write-Step "Running SQL scripts against $Database"

foreach ($fileName in $SqlScripts) {
    $filePath = Join-Path $ScriptsDir $fileName
    Invoke-SqlFile -Db $Database -FilePath $filePath -Label $fileName
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Database  : $Database" -ForegroundColor Green
Write-Host "  Container : $ContainerName" -ForegroundColor Green
Write-Host "  Seed password: $SeedPassword" -ForegroundColor Green
Write-Host "  Connect   : psql -h $DbHost -p $Port -U $User -d $Database" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
