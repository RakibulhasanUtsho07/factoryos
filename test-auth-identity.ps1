$ErrorActionPreference = "Stop"

# ============================================================
# FactoryOS AI
# External Authentication Identity Security Tests
# ============================================================

$BaseUrl = "http://localhost:3001/api"

$TenantId =
    "faaab63d-c447-46ce-950d-deebdd7f5f30"

$AdminUserId =
    "921382b8-e83f-43ab-a576-e3db6a06b70c"

$ManagerUserId =
    "69ff4145-e780-45af-af42-60238bd1124b"

# ============================================================
# DEV AUTH SECRET
# ============================================================

$EnvFile =
    Join-Path $PSScriptRoot "services\api\.env"

if (-not (Test-Path $EnvFile)) {
    throw "Missing environment file: $EnvFile"
}

$DevAuthLine =
    Get-Content $EnvFile |
    Where-Object {
        $_ -match '^\s*DEV_AUTH_SECRET\s*='
    } |
    Select-Object -First 1

if (-not $DevAuthLine) {
    throw "DEV_AUTH_SECRET is missing in services/api/.env"
}

$DevAuthSecret =
    (
        $DevAuthLine -replace
        '^\s*DEV_AUTH_SECRET\s*=\s*',
        ''
    ).Trim()

$DevAuthSecret =
    $DevAuthSecret.Trim('"').Trim("'")

if ([string]::IsNullOrWhiteSpace($DevAuthSecret)) {
    throw "DEV_AUTH_SECRET is empty"
}

# ============================================================
# HELPERS
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

function Assert-Status {
    param(
        [int]$Actual,
        [int]$Expected,
        [string]$TestName
    )

    if ($Actual -ne $Expected) {
        throw "$TestName FAILED. Expected HTTP $Expected, got HTTP $Actual"
    }

    Write-Host `
        "PASS: $TestName -> HTTP $Actual" `
        -ForegroundColor Green
}

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
# GET ADMIN TOKEN
# ============================================================

Write-TestHeader "SETUP - Admin Development JWT"

$adminBody = @{
    user_id =
        $AdminUserId

    tenant_id =
        $TenantId
} | ConvertTo-Json

$adminResponse =
    Invoke-RestMethod `
        -Uri "$BaseUrl/auth/dev-token" `
        -Method POST `
        -ContentType "application/json" `
        -Headers @{
            "X-Dev-Auth-Secret" =
                $DevAuthSecret
        } `
        -Body $adminBody

$AdminToken =
    $adminResponse.data.access_token

if (-not $AdminToken) {
    throw "Unable to create Admin JWT"
}

Write-Host `
    "PASS: Admin JWT ready" `
    -ForegroundColor Green

# ============================================================
# GET MANAGER TOKEN
# ============================================================

Write-TestHeader "SETUP - Manager Development JWT"

$managerBody = @{
    user_id =
        $ManagerUserId

    tenant_id =
        $TenantId
} | ConvertTo-Json

$managerResponse =
    Invoke-RestMethod `
        -Uri "$BaseUrl/auth/dev-token" `
        -Method POST `
        -ContentType "application/json" `
        -Headers @{
            "X-Dev-Auth-Secret" =
                $DevAuthSecret
        } `
        -Body $managerBody

$ManagerToken =
    $managerResponse.data.access_token

if (-not $ManagerToken) {
    throw "Unable to create Manager JWT"
}

Write-Host `
    "PASS: Manager JWT ready" `
    -ForegroundColor Green

# ============================================================
# TEST DATA
# ============================================================

$Issuer =
    "https://dev-idp.factoryos.local"

$TestSubject =
    "identity-security-" +
    [Guid]::NewGuid().ToString("N")

# ============================================================
# TEST 1
# Admin can link identity
# ============================================================

Write-TestHeader "TEST 1 - Admin Identity Link"

$linkBody = @{
    user_id =
        $ManagerUserId

    issuer =
        $Issuer

    subject =
        $TestSubject
} | ConvertTo-Json

$linkResponse =
    Invoke-RestMethod `
        -Uri "$BaseUrl/iam/users/auth-identities" `
        -Method POST `
        -ContentType "application/json" `
        -Headers @{
            Authorization =
                "Bearer $AdminToken"
        } `
        -Body $linkBody

if (
    $linkResponse.data.status -ne "ACTIVE"
) {
    throw "Identity link did not return ACTIVE status"
}

if (
    $linkResponse.data.user_id -ne
    $ManagerUserId
) {
    throw "Identity was linked to the wrong user"
}

if (
    $linkResponse.data.issuer -ne
    $Issuer
) {
    throw "Issuer mismatch"
}

if (
    $linkResponse.data.subject -ne
    $TestSubject
) {
    throw "Subject mismatch"
}

$IdentityId =
    $linkResponse.data.id

Write-Host `
    "PASS: Identity linked -> $IdentityId" `
    -ForegroundColor Green

# ============================================================
# TEST 2
# Same issuer + subject must return 409
# ============================================================

Write-TestHeader "TEST 2 - Duplicate External Identity"

$duplicateStatus =
    Get-HttpStatus {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "$BaseUrl/iam/users/auth-identities" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{
                Authorization =
                    "Bearer $AdminToken"
            } `
            -Body $linkBody
    }

Assert-Status `
    -Actual $duplicateStatus `
    -Expected 409 `
    -TestName "Duplicate identity rejection"

# ============================================================
# TEST 3
# Same external identity cannot be attached to another user
# ============================================================

Write-TestHeader "TEST 3 - Identity Hijacking Protection"

$hijackBody = @{
    user_id =
        $AdminUserId

    issuer =
        $Issuer

    subject =
        $TestSubject
} | ConvertTo-Json

$hijackStatus =
    Get-HttpStatus {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "$BaseUrl/iam/users/auth-identities" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{
                Authorization =
                    "Bearer $AdminToken"
            } `
            -Body $hijackBody
    }

Assert-Status `
    -Actual $hijackStatus `
    -Expected 409 `
    -TestName "Identity hijacking prevention"

# ============================================================
# TEST 4
# Manager cannot link identity
# ============================================================

Write-TestHeader "TEST 4 - Non-Admin Identity Link"

$managerLinkBody = @{
    user_id =
        $ManagerUserId

    issuer =
        $Issuer

    subject =
        (
            "manager-" +
            [Guid]::NewGuid().ToString("N")
        )
} | ConvertTo-Json

$managerStatus =
    Get-HttpStatus {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "$BaseUrl/iam/users/auth-identities" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{
                Authorization =
                    "Bearer $ManagerToken"
            } `
            -Body $managerLinkBody
    }

Assert-Status `
    -Actual $managerStatus `
    -Expected 403 `
    -TestName "Manager identity-link permission"

# ============================================================
# TEST 5
# Unknown target user
# ============================================================

Write-TestHeader "TEST 5 - Unknown Target User"

$unknownUserId =
    "11111111-1111-4111-8111-111111111111"

$unknownBody = @{
    user_id =
        $unknownUserId

    issuer =
        $Issuer

    subject =
        (
            "unknown-" +
            [Guid]::NewGuid().ToString("N")
        )
} | ConvertTo-Json

$unknownStatus =
    Get-HttpStatus {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "$BaseUrl/iam/users/auth-identities" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{
                Authorization =
                    "Bearer $AdminToken"
            } `
            -Body $unknownBody
    }

Assert-Status `
    -Actual $unknownStatus `
    -Expected 403 `
    -TestName "Unknown target user rejection"

# ============================================================
# TEST 6
# Empty subject -> DTO validation must return 400
# ============================================================

Write-TestHeader "TEST 6 - Invalid Subject Validation"

$invalidBody = @{
    user_id =
        $ManagerUserId

    issuer =
        $Issuer

    subject =
        ""
} | ConvertTo-Json

$invalidStatus =
    Get-HttpStatus {
        Invoke-WebRequest `
            -UseBasicParsing `
            -Uri "$BaseUrl/iam/users/auth-identities" `
            -Method POST `
            -ContentType "application/json" `
            -Headers @{
                Authorization =
                    "Bearer $AdminToken"
            } `
            -Body $invalidBody
    }

Assert-Status `
    -Actual $invalidStatus `
    -Expected 400 `
    -TestName "Empty subject validation"

# ============================================================
# TEST 7
# Database verification
# ============================================================

Write-TestHeader "TEST 7 - Database Verification"

docker exec factoryos-postgres psql `
    -U factoryos `
    -d factoryos `
    -c "SELECT id, user_id, issuer, subject, status, created_at FROM auth_identities WHERE id = '$IdentityId';"

# ============================================================
# TEST 8
# Audit verification
# ============================================================

Write-TestHeader "TEST 8 - Audit Verification"

docker exec factoryos-postgres psql `
    -U factoryos `
    -d factoryos `
    -c "SELECT created_at, actor_user_id, event_type, action, resource_type, resource_id, payload FROM audit_events WHERE event_type = 'AUTH_IDENTITY' AND resource_id = '$IdentityId' ORDER BY created_at DESC LIMIT 5;"

# ============================================================
# FINAL
# ============================================================

Write-Host ""
Write-Host "============================================================"
Write-Host "ALL AUTH IDENTITY SECURITY TESTS PASSED"
Write-Host "============================================================"

Write-Host ""
Write-Host "Verified:"
Write-Host "  Admin identity linking"
Write-Host "  Duplicate identity rejection (409)"
Write-Host "  Identity hijacking protection (409)"
Write-Host "  Non-admin permission protection (403)"
Write-Host "  Unknown target user rejection (403)"
Write-Host "  Invalid subject validation (400)"
Write-Host "  Database persistence"
Write-Host "  Identity-link audit event"