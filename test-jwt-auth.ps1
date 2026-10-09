$ErrorActionPreference = "Stop"

# ============================================================
# FactoryOS AI
# JWT Authentication + IAM + Factory Scope + Audit Test
# ============================================================

$BaseUrl = "http://localhost:3001/api"

# ------------------------------------------------------------
# Existing local development IDs
# ------------------------------------------------------------

$TenantId = "faaab63d-c447-46ce-950d-deebdd7f5f30"

$AdminUserId = "921382b8-e83f-43ab-a576-e3db6a06b70c"

$ManagerUserId = "69ff4145-e780-45af-af42-60238bd1124b"

$FactoryAId = "24f17c4f-b34f-4d6b-8ebd-37fbf73e36e7"

$FactoryBId = "87a600fe-aa25-4671-824b-43af6110425b"


# ============================================================
# Helper: print test section
# ============================================================

function Write-TestHeader {
    param(
        [string]$Name
    )

    Write-Host ""
    Write-Host "============================================================"
    Write-Host $Name
    Write-Host "============================================================"
}


# ============================================================
# Helper: assert HTTP status
# ============================================================

function Assert-Status {
    param(
        [int]$Actual,
        [int]$Expected,
        [string]$TestName
    )

    if ($Actual -ne $Expected) {
        throw "$TestName FAILED. Expected HTTP $Expected but got HTTP $Actual"
    }

    Write-Host "PASS: $TestName -> HTTP $Actual" -ForegroundColor Green
}


# ============================================================
# Helper: make request and return HTTP status
#
# Invoke-WebRequest throws for 4xx/5xx, so this catches the
# response and extracts the actual HTTP status code.
# ============================================================

function Get-HttpStatus {
    param(
        [scriptblock]$Request
    )

    try {
        & $Request | Out-Null

        return 200
    }
    catch {
        if ($_.Exception.Response) {
            return [int]$_.Exception.Response.StatusCode
        }

        throw
    }
}


# ============================================================
# Load DEV_AUTH_SECRET automatically from services/api/.env
# ============================================================

$EnvFile = Join-Path $PSScriptRoot "services\api\.env"

if (-not (Test-Path $EnvFile)) {
    throw "Environment file not found: $EnvFile"
}

$DevAuthLine = Get-Content $EnvFile |
    Where-Object {
        $_ -match '^\s*DEV_AUTH_SECRET\s*='
    } |
    Select-Object -First 1

if (-not $DevAuthLine) {
    throw "DEV_AUTH_SECRET is missing in services/api/.env"
}

$DevAuthSecret = (
    $DevAuthLine -replace '^\s*DEV_AUTH_SECRET\s*=\s*', ''
).Trim()

# Support optional surrounding quotes:
# DEV_AUTH_SECRET="abc"
# DEV_AUTH_SECRET='abc'
$DevAuthSecret = $DevAuthSecret.Trim('"', "'")

if ([string]::IsNullOrWhiteSpace($DevAuthSecret)) {
    throw "DEV_AUTH_SECRET is empty in services/api/.env"
}

if ($DevAuthSecret -eq "YOUR_DEV_AUTH_SECRET") {
    throw "DEV_AUTH_SECRET still contains placeholder value."
}

Write-Host "Loaded DEV_AUTH_SECRET from services/api/.env" -ForegroundColor Cyan


# ============================================================
# TEST 1
# Health endpoint is public
# ============================================================

Write-TestHeader "TEST 1 - Public Health Endpoint"

$healthStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/health" `
        -Method GET
}

Assert-Status `
    -Actual $healthStatus `
    -Expected 200 `
    -TestName "Public health endpoint"


# ============================================================
# TEST 2
# Protected endpoint without JWT
# Must return 401
# ============================================================

Write-TestHeader "TEST 2 - Protected Endpoint Without JWT"

$noTokenStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/authorization-test" `
        -Method GET
}

Assert-Status `
    -Actual $noTokenStatus `
    -Expected 401 `
    -TestName "IAM endpoint without JWT"


# ============================================================
# TEST 3
# Issue Admin development JWT
# ============================================================

Write-TestHeader "TEST 3 - Issue Admin Development JWT"

$adminTokenBody = @{
    user_id   = $AdminUserId
    tenant_id = $TenantId
} | ConvertTo-Json

$adminTokenResponse = Invoke-RestMethod `
    -Uri "$BaseUrl/auth/dev-token" `
    -Method POST `
    -ContentType "application/json" `
    -Headers @{
        "X-Dev-Auth-Secret" = $DevAuthSecret
    } `
    -Body $adminTokenBody

if (
    -not $adminTokenResponse.data `
    -or `
    -not $adminTokenResponse.data.access_token
) {
    throw "Admin JWT was not returned."
}

$AdminToken = [string]$adminTokenResponse.data.access_token

Write-Host "PASS: Admin JWT issued" -ForegroundColor Green


# ============================================================
# TEST 4
# Admin JWT -> /auth/me
# ============================================================

Write-TestHeader "TEST 4 - Admin JWT /auth/me"

$adminMe = Invoke-RestMethod `
    -Uri "$BaseUrl/auth/me" `
    -Method GET `
    -Headers @{
        Authorization = "Bearer $AdminToken"
    }

if ($adminMe.data.authenticated -ne $true) {
    throw "Admin /auth/me did not return authenticated=true."
}

if ($adminMe.data.user.userId -ne $AdminUserId) {
    throw "Admin /auth/me returned unexpected userId."
}

if ($adminMe.data.user.tenantId -ne $TenantId) {
    throw "Admin /auth/me returned unexpected tenantId."
}

Write-Host "PASS: Admin identity verified" -ForegroundColor Green


# ============================================================
# TEST 5
# Admin JWT -> tenant-level permission check
# ============================================================

Write-TestHeader "TEST 5 - Admin Tenant Authorization"

$adminAuth = Invoke-RestMethod `
    -Uri "$BaseUrl/iam/authorization-test" `
    -Method GET `
    -Headers @{
        Authorization = "Bearer $AdminToken"
    }

if ($adminAuth.data.authorized -ne $true) {
    throw "Admin authorization failed."
}

Write-Host "PASS: Admin tenant authorization" -ForegroundColor Green


# ============================================================
# TEST 6
# Admin + Factory A
# Must return 200
# ============================================================

Write-TestHeader "TEST 6 - Admin Factory A Authorization"

$adminFactoryAStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $AdminToken"
            "X-Factory-Id" = $FactoryAId
        }
}

Assert-Status `
    -Actual $adminFactoryAStatus `
    -Expected 200 `
    -TestName "Admin + Factory A"


# ============================================================
# TEST 7
# Admin + Factory B
# Must return 200
# ============================================================

Write-TestHeader "TEST 7 - Admin Factory B Authorization"

$adminFactoryBStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $AdminToken"
            "X-Factory-Id" = $FactoryBId
        }
}

Assert-Status `
    -Actual $adminFactoryBStatus `
    -Expected 200 `
    -TestName "Admin + Factory B"


# ============================================================
# TEST 8
# Issue Manager development JWT
# ============================================================

Write-TestHeader "TEST 8 - Issue Manager Development JWT"

$managerTokenBody = @{
    user_id   = $ManagerUserId
    tenant_id = $TenantId
} | ConvertTo-Json

$managerTokenResponse = Invoke-RestMethod `
    -Uri "$BaseUrl/auth/dev-token" `
    -Method POST `
    -ContentType "application/json" `
    -Headers @{
        "X-Dev-Auth-Secret" = $DevAuthSecret
    } `
    -Body $managerTokenBody

if (
    -not $managerTokenResponse.data `
    -or `
    -not $managerTokenResponse.data.access_token
) {
    throw "Manager JWT was not returned."
}

$ManagerToken = [string]$managerTokenResponse.data.access_token

Write-Host "PASS: Manager JWT issued" -ForegroundColor Green


# ============================================================
# TEST 9
# Manager JWT -> /auth/me
# ============================================================

Write-TestHeader "TEST 9 - Manager JWT /auth/me"

$managerMe = Invoke-RestMethod `
    -Uri "$BaseUrl/auth/me" `
    -Method GET `
    -Headers @{
        Authorization = "Bearer $ManagerToken"
    }

if ($managerMe.data.authenticated -ne $true) {
    throw "Manager /auth/me did not return authenticated=true."
}

if ($managerMe.data.user.userId -ne $ManagerUserId) {
    throw "Manager /auth/me returned unexpected userId."
}

if ($managerMe.data.user.tenantId -ne $TenantId) {
    throw "Manager /auth/me returned unexpected tenantId."
}

Write-Host "PASS: Manager identity verified" -ForegroundColor Green


# ============================================================
# TEST 10
# Manager + Factory A
# Must return 200
# ============================================================

Write-TestHeader "TEST 10 - Manager Factory A Authorization"

$managerFactoryAStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $ManagerToken"
            "X-Factory-Id" = $FactoryAId
        }
}

Assert-Status `
    -Actual $managerFactoryAStatus `
    -Expected 200 `
    -TestName "Manager + Factory A"


# ============================================================
# TEST 11
# Manager + Factory B
# Must return 403
# ============================================================

Write-TestHeader "TEST 11 - Manager Factory B Authorization"

$managerFactoryBStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $ManagerToken"
            "X-Factory-Id" = $FactoryBId
        }
}

Assert-Status `
    -Actual $managerFactoryBStatus `
    -Expected 403 `
    -TestName "Manager + Factory B"


# ============================================================
# TEST 12
# Anti-spoofing:
#
# JWT says MANAGER
# Header says ADMIN
#
# Authorization MUST still use MANAGER.
# Factory B should therefore remain forbidden.
# ============================================================

Write-TestHeader "TEST 12 - X-User-Id Spoofing Protection"

$spoofedStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $ManagerToken"
            "X-User-Id"    = $AdminUserId
            "X-Factory-Id" = $FactoryBId
        }
}

Assert-Status `
    -Actual $spoofedStatus `
    -Expected 403 `
    -TestName "Manager JWT + spoofed Admin X-User-Id"


# ============================================================
# TEST 13
# Tenant spoofing:
#
# JWT tenant = real tenant
# X-Tenant-Id = fake tenant
#
# PermissionGuard must reject mismatch.
# ============================================================

Write-TestHeader "TEST 13 - Tenant Spoofing Protection"

$FakeTenantId = "00000000-0000-0000-0000-000000000001"

$tenantSpoofStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $ManagerToken"
            "X-Tenant-Id"  = $FakeTenantId
        }
}

Assert-Status `
    -Actual $tenantSpoofStatus `
    -Expected 403 `
    -TestName "Tenant spoofing protection"


# ============================================================
# TEST 14
# Invalid JWT
# Must return 401
# ============================================================

Write-TestHeader "TEST 14 - Invalid JWT"

$invalidJwtStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer definitely-not-a-valid-jwt"
        }
}

Assert-Status `
    -Actual $invalidJwtStatus `
    -Expected 401 `
    -TestName "Invalid JWT rejection"


# ============================================================
# TEST 15
# Factory-scoped endpoint without factory ID
# ============================================================

Write-TestHeader "TEST 15 - Missing Factory Scope"

$missingFactoryStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/iam/factory-authorization-test" `
        -Method GET `
        -Headers @{
            Authorization = "Bearer $ManagerToken"
        }
}

Assert-Status `
    -Actual $missingFactoryStatus `
    -Expected 401 `
    -TestName "Missing factory scope"


# ============================================================
# TEST 16
# Wrong development auth secret
# Must return 401
# ============================================================

Write-TestHeader "TEST 16 - Invalid Dev Auth Secret"

$badSecretStatus = Get-HttpStatus {
    Invoke-WebRequest `
        -UseBasicParsing `
        -Uri "$BaseUrl/auth/dev-token" `
        -Method POST `
        -ContentType "application/json" `
        -Headers @{
            "X-Dev-Auth-Secret" = "incorrect-development-secret"
        } `
        -Body $adminTokenBody
}

Assert-Status `
    -Actual $badSecretStatus `
    -Expected 401 `
    -TestName "Invalid dev auth secret"


# ============================================================
# TEST 17
# Audit verification
#
# Show recent authorization events from PostgreSQL.
# ============================================================

Write-TestHeader "TEST 17 - Audit Event Verification"

docker exec factoryos-postgres psql `
    -U factoryos `
    -d factoryos `
    -c "SELECT created_at, actor_user_id, factory_id, event_type, action, correlation_id, request_id, data_class, payload FROM audit_events ORDER BY created_at DESC LIMIT 15;"


# ============================================================
# FINAL
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "ALL FACTORYOS JWT AUTH TESTS PASSED"
Write-Host "============================================================"
Write-Host ""
Write-Host "Verified:"
Write-Host "  Public health endpoint"
Write-Host "  JWT required for protected endpoints"
Write-Host "  Admin JWT identity"
Write-Host "  Manager JWT identity"
Write-Host "  Tenant authorization"
Write-Host "  Factory A authorization"
Write-Host "  Factory B authorization"
Write-Host "  X-User-Id spoofing protection"
Write-Host "  X-Tenant-Id spoofing protection"
Write-Host "  Invalid JWT rejection"
Write-Host "  Missing factory scope rejection"
Write-Host "  Invalid dev secret rejection"
Write-Host "  Authorization audit events"
Write-Host ""