#!/usr/bin/env bash
# Encrypted PostgreSQL backup/restore rehearsal with a release-gate evidence contract.
# Credentials belong in protected libpq service/pass files and an approved GPG keyring.
set -Eeuo pipefail
umask 077

die() { printf 'recovery rehearsal failed at %s: %s\n' "${current_stage:-preflight}" "$*" >&2; exit 1; }
need_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
need_value() {
  local name="$1" value="${2:-}"
  [[ -n "$value" ]] || die "required environment variable is missing: $name"
}
utc_now() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
epoch_now() { date -u '+%s'; }

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source_service="${FACTORYOS_BACKUP_PGSERVICE:-}"
target_service="${FACTORYOS_RESTORE_PGSERVICE:-}"
backup_file="${FACTORYOS_BACKUP_OUTPUT:-}"
recipient="${FACTORYOS_BACKUP_GPG_RECIPIENT:-}"
smoke_sql="${FACTORYOS_RESTORE_SMOKE_SQL:-}"
dr_mode="${FACTORYOS_DR_MODE:-BASIC}"
manifest_mode="${FACTORYOS_MIGRATION_MANIFEST_MODE:-PENDING}"
candidate_manifest="${FACTORYOS_CANDIDATE_MIGRATION_MANIFEST:-}"
watermark_sql="${FACTORYOS_RECOVERY_WATERMARK_SQL:-}"
failure_probe_sql="${FACTORYOS_MIGRATION_FAILURE_PROBE_SQL:-$repo_root/services/api/test/migration-recovery-failure.sql}"
evidence_file="${FACTORYOS_RECOVERY_EVIDENCE_JSON:-}"
event_time_utc="${FACTORYOS_RECOVERY_EVENT_TIME_UTC:-}"
app_database_url="${FACTORYOS_DR_APPLICATION_DATABASE_URL:-}"
erasure_replay_sql="${FACTORYOS_RESTORE_ERASURE_REPLAY_SQL:-}"
erasure_verify_sql="${FACTORYOS_RESTORE_ERASURE_VERIFY_SQL:-}"
erasure_ledger_reference="${FACTORYOS_RESTORE_ERASURE_LEDGER_REFERENCE:-}"
erasure_ledger_sha256="${FACTORYOS_RESTORE_ERASURE_LEDGER_SHA256:-}"
candidate_sha="${FACTORYOS_CANDIDATE_SHA:-}"

current_stage="configuration"
rehearsal_status="RUNNING"
started_at_utc="$(utc_now)"
started_epoch="$(epoch_now)"
backup_started_epoch=""
backup_duration_seconds=""
restore_started_epoch=""
restore_duration_seconds=""
source_identity=""
target_identity=""
source_watermark_utc=""
restored_watermark_utc=""
observed_rpo_seconds=""
observed_rto_seconds=""
candidate_manifest_sha256=""
candidate_migration_count=0
candidate_migration_status="NOT_RUN"
failure_recovery_status="NOT_RUN"
schema_smoke_status="NOT_REPORTED"
application_smoke_status="NOT_REPORTED"
api_readiness_status="NOT_REPORTED"
tenant_isolation_status="NOT_REPORTED"
audit_continuity_status="NOT_REPORTED"
erasure_replay_status="NOT_RUN"
erasure_ledger_watermark_utc=""
erasure_replayed_requests=""
erasure_replay_residuals=""
erasure_replay_sql_sha256=""
erasure_verify_sql_sha256=""
checksum_sha256=""
checksum_verified=false
archive_status="NOT_RUN"
encryption_status="NOT_RUN"
restore_status="NOT_RUN"
target_empty=false
distinct_database_identity=false
server_version=""
pg_dump_version=""
pg_restore_version=""
gpg_version=""
target_assessment="OWNER_APPROVAL_REQUIRED"
rpo_target_seconds="${FACTORYOS_RECOVERY_RPO_TARGET_SECONDS:-}"
rto_target_seconds="${FACTORYOS_RECOVERY_RTO_TARGET_SECONDS:-}"
targets_approved=false
tmpdir=""
partial_file=""

emit_evidence() {
  local exit_code="$1"
  [[ -n "$evidence_file" ]] || return 0
  need_command node
  export FACTORYOS_DR_STATUS="$rehearsal_status"
  export FACTORYOS_DR_STAGE="$current_stage"
  export FACTORYOS_DR_EXIT_CODE="$exit_code"
  export FACTORYOS_DR_STARTED_AT_UTC="$started_at_utc"
  export FACTORYOS_DR_FINISHED_AT_UTC="$(utc_now)"
  export FACTORYOS_DR_SOURCE_IDENTITY="$source_identity"
  export FACTORYOS_DR_TARGET_IDENTITY="$target_identity"
  export FACTORYOS_DR_DATABASE_IDENTITIES_DISTINCT="$distinct_database_identity"
  export FACTORYOS_DR_TARGET_EMPTY="$target_empty"
  export FACTORYOS_DR_BACKUP_SHA256="$checksum_sha256"
  export FACTORYOS_DR_CHECKSUM_VERIFIED="$checksum_verified"
  export FACTORYOS_DR_ENCRYPTION_STATUS="$encryption_status"
  export FACTORYOS_DR_ARCHIVE_STATUS="$archive_status"
  export FACTORYOS_DR_RESTORE_STATUS="$restore_status"
  export FACTORYOS_DR_SCHEMA_SMOKE_STATUS="$schema_smoke_status"
  export FACTORYOS_DR_APPLICATION_SMOKE_STATUS="$application_smoke_status"
  export FACTORYOS_DR_API_READINESS_STATUS="$api_readiness_status"
  export FACTORYOS_DR_TENANT_ISOLATION_STATUS="$tenant_isolation_status"
  export FACTORYOS_DR_AUDIT_CONTINUITY_STATUS="$audit_continuity_status"
  export FACTORYOS_DR_ERASURE_REPLAY_STATUS="$erasure_replay_status"
  export FACTORYOS_DR_ERASURE_LEDGER_REFERENCE="$erasure_ledger_reference"
  export FACTORYOS_DR_ERASURE_LEDGER_SHA256="$erasure_ledger_sha256"
  export FACTORYOS_DR_ERASURE_LEDGER_WATERMARK_UTC="$erasure_ledger_watermark_utc"
  export FACTORYOS_DR_ERASURE_REPLAYED_REQUESTS="$erasure_replayed_requests"
  export FACTORYOS_DR_ERASURE_REPLAY_RESIDUALS="$erasure_replay_residuals"
  export FACTORYOS_DR_ERASURE_REPLAY_SQL_SHA256="$erasure_replay_sql_sha256"
  export FACTORYOS_DR_ERASURE_VERIFY_SQL_SHA256="$erasure_verify_sql_sha256"
  export FACTORYOS_DR_CANDIDATE_MIGRATION_MANIFEST="$candidate_manifest"
  export FACTORYOS_DR_MIGRATION_MANIFEST_MODE="$manifest_mode"
  export FACTORYOS_DR_CANDIDATE_MANIFEST_SHA256="$candidate_manifest_sha256"
  export FACTORYOS_DR_CANDIDATE_MIGRATION_COUNT="$candidate_migration_count"
  export FACTORYOS_DR_CANDIDATE_MIGRATION_STATUS="$candidate_migration_status"
  export FACTORYOS_DR_FAILURE_RECOVERY_STATUS="$failure_recovery_status"
  export FACTORYOS_DR_BACKUP_DURATION_SECONDS="$backup_duration_seconds"
  export FACTORYOS_DR_RESTORE_DURATION_SECONDS="$restore_duration_seconds"
  export FACTORYOS_DR_SOURCE_WATERMARK_UTC="$source_watermark_utc"
  export FACTORYOS_DR_RESTORED_WATERMARK_UTC="$restored_watermark_utc"
  export FACTORYOS_DR_EVENT_TIME_UTC="$event_time_utc"
  export FACTORYOS_DR_OBSERVED_RPO_SECONDS="$observed_rpo_seconds"
  export FACTORYOS_DR_OBSERVED_RTO_SECONDS="$observed_rto_seconds"
  export FACTORYOS_DR_TARGETS_APPROVED="$targets_approved"
  export FACTORYOS_DR_RPO_TARGET_SECONDS="$rpo_target_seconds"
  export FACTORYOS_DR_RTO_TARGET_SECONDS="$rto_target_seconds"
  export FACTORYOS_DR_TARGET_ASSESSMENT="$target_assessment"
  export FACTORYOS_DR_OPERATOR="${FACTORYOS_RECOVERY_OPERATOR:-}"
  export FACTORYOS_DR_APPROVER="${FACTORYOS_RECOVERY_APPROVER:-}"
  export FACTORYOS_DR_PG_DUMP_VERSION="$pg_dump_version"
  export FACTORYOS_DR_PG_RESTORE_VERSION="$pg_restore_version"
  export FACTORYOS_DR_SERVER_VERSION="$server_version"
  export FACTORYOS_DR_GPG_VERSION="$gpg_version"
  node "$repo_root/scripts/recovery/write-rehearsal-evidence.mjs"
}

cleanup() {
  local exit_code="$?"
  trap - EXIT
  [[ "$rehearsal_status" != "RUNNING" ]] || rehearsal_status="TECHNICAL_FAIL"
  [[ -z "$partial_file" ]] || rm -f -- "$partial_file"
  if [[ -n "$evidence_file" ]]; then
    if ! emit_evidence "$exit_code"; then
      printf 'recovery rehearsal failed: unable to write the evidence receipt\n' >&2
      [[ "$exit_code" -ne 0 ]] || exit_code=1
    fi
  fi
  [[ -z "$tmpdir" ]] || rm -rf -- "$tmpdir"
  exit "$exit_code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# Guard checks intentionally happen before any database client is invoked.
need_value FACTORYOS_BACKUP_PGSERVICE "$source_service"
need_value FACTORYOS_RESTORE_PGSERVICE "$target_service"
need_value FACTORYOS_BACKUP_OUTPUT "$backup_file"
need_value FACTORYOS_BACKUP_GPG_RECIPIENT "$recipient"
need_value FACTORYOS_RESTORE_SMOKE_SQL "$smoke_sql"

[[ "$dr_mode" == "BASIC" || "$dr_mode" == "RELEASE_GATE" ]] || die "FACTORYOS_DR_MODE must be BASIC or RELEASE_GATE"
[[ "$source_service" =~ ^[A-Za-z0-9_.-]{1,63}$ ]] || die "backup service name contains unsupported characters"
[[ "$target_service" =~ ^[A-Za-z0-9_.-]{1,63}$ ]] || die "restore service name contains unsupported characters"
[[ "$source_service" != "$target_service" ]] || die "backup and restore service names must differ"
[[ "$backup_file" == /* ]] || die "FACTORYOS_BACKUP_OUTPUT must be an absolute path"
[[ "$backup_file" == *.dump.gpg ]] || die "backup output must end in .dump.gpg (encrypted custom-format archive)"
[[ -d "$(dirname "$backup_file")" ]] || die "backup output directory must already exist on approved restricted storage"
[[ ! -e "$backup_file" && ! -L "$backup_file" ]] || die "backup output already exists; refusing to overwrite evidence"
[[ ! -e "${backup_file}.sha256" && ! -L "${backup_file}.sha256" ]] || die "checksum output already exists; refusing to overwrite evidence"
[[ -f "$smoke_sql" && -r "$smoke_sql" ]] || die "restore verification SQL must be a readable reviewed file"
[[ "${FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE:-}" == "I_HAVE_VERIFIED_EMPTY" ]] || die "confirm the restore target is disposable and isolated before continuing"

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  need_value FACTORYOS_RECOVERY_EVIDENCE_JSON "$evidence_file"
  need_value FACTORYOS_CANDIDATE_MIGRATION_MANIFEST "$candidate_manifest"
  [[ "$manifest_mode" == "PENDING" || "$manifest_mode" == "IDEMPOTENT_REPLAY" ]] || die "FACTORYOS_MIGRATION_MANIFEST_MODE must be PENDING or IDEMPOTENT_REPLAY"
  need_value FACTORYOS_RECOVERY_WATERMARK_SQL "$watermark_sql"
  need_value FACTORYOS_RECOVERY_EVENT_TIME_UTC "$event_time_utc"
  need_value FACTORYOS_RECOVERY_OPERATOR "${FACTORYOS_RECOVERY_OPERATOR:-}"
  need_value FACTORYOS_RECOVERY_APPROVER "${FACTORYOS_RECOVERY_APPROVER:-}"
  need_value FACTORYOS_CANDIDATE_SHA "$candidate_sha"
  need_value FACTORYOS_RESTORE_ERASURE_REPLAY_SQL "$erasure_replay_sql"
  need_value FACTORYOS_RESTORE_ERASURE_VERIFY_SQL "$erasure_verify_sql"
  need_value FACTORYOS_RESTORE_ERASURE_LEDGER_REFERENCE "$erasure_ledger_reference"
  need_value FACTORYOS_RESTORE_ERASURE_LEDGER_SHA256 "$erasure_ledger_sha256"
  [[ "$candidate_sha" =~ ^[a-f0-9]{40}$ ]] || die "candidate SHA must be a full 40-character lowercase commit SHA"
  [[ "$erasure_ledger_reference" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$ ]] || die "erasure ledger reference must be a safe opaque identifier"
  [[ "$erasure_ledger_sha256" =~ ^[a-f0-9]{64}$ ]] || die "erasure ledger SHA-256 must be 64 lowercase hexadecimal characters"
  [[ "$evidence_file" == /* ]] || die "evidence output must be an absolute path"
  [[ -d "$(dirname "$evidence_file")" ]] || die "evidence output directory must already exist"
  [[ ! -e "$evidence_file" && ! -L "$evidence_file" ]] || die "evidence output already exists; refusing to overwrite a receipt"
  [[ "$FACTORYOS_RECOVERY_OPERATOR" != "$FACTORYOS_RECOVERY_APPROVER" ]] || die "operator and approver must be different people"
  [[ -f "$watermark_sql" && -r "$watermark_sql" ]] || die "watermark SQL must be a readable reviewed query"
  [[ -f "$failure_probe_sql" && -r "$failure_probe_sql" ]] || die "migration failure-recovery probe SQL is missing or unreadable"
  for replay_file in "$erasure_replay_sql" "$erasure_verify_sql"; do
    [[ "$replay_file" == /* && -f "$replay_file" && -r "$replay_file" && ! -L "$replay_file" ]] || die "restore erasure replay and verification SQL must be absolute readable regular files, not symlinks"
    replay_mode="$(stat -c '%a' -- "$replay_file")" || die "could not inspect restore erasure SQL permissions"
    [[ "$replay_mode" =~ ^[0-7]{3,4}$ ]] || die "restore erasure SQL permissions could not be verified"
    (( (8#$replay_mode & 0022) == 0 )) || die "restore erasure SQL must not be group/world writable"
  done
  [[ "$(readlink -f -- "$erasure_replay_sql")" != "$(readlink -f -- "$erasure_verify_sql")" ]] || die "restore erasure replay and verification SQL must be separate files"
  [[ "$event_time_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$ ]] || die "event time must be UTC RFC 3339 ending in Z"
  date -u -d "$event_time_utc" +%s >/dev/null 2>&1 || die "event timestamp is invalid"
  event_epoch_preflight="$(date -u -d "$event_time_utc" +%s)"
  current_epoch_preflight="$(epoch_now)"
  (( event_epoch_preflight <= current_epoch_preflight )) || die "event/cutoff timestamp cannot be in the future"
  [[ "$candidate_manifest" != /* && "$candidate_manifest" != *".."* ]] || die "candidate manifest must be a repository-relative path without traversal"
  [[ -f "$repo_root/$candidate_manifest" && -r "$repo_root/$candidate_manifest" ]] || die "candidate migration manifest is missing or unreadable"
  need_command node
  need_command git
  [[ "$(git -C "$repo_root" rev-parse HEAD)" == "$candidate_sha" ]] || die "candidate SHA does not match the checked-out repository"
  if ! (cd "$repo_root" && node scripts/audit/verify-migration-manifest.mjs); then
    die "canonical ordered migration manifest failed inventory verification"
  fi
  if [[ "${FACTORYOS_DR_TARGETS_APPROVED:-NO}" == "YES" ]]; then
    targets_approved=true
    [[ "$rpo_target_seconds" =~ ^[0-9]+$ ]] || die "approved RPO target must be integer seconds"
    [[ "$rto_target_seconds" =~ ^[0-9]+$ ]] || die "approved RTO target must be integer seconds"
    target_assessment="PENDING_MEASUREMENTS"
  else
    rpo_target_seconds=""
    rto_target_seconds=""
    target_assessment="NOT_APPROVED_NOT_CONTRACTUAL"
  fi
  need_value FACTORYOS_DR_APPLICATION_DATABASE_URL "$app_database_url"
  [[ -f "$repo_root/services/api/dist/main.js" ]] || die "candidate API build is missing; build the exact candidate before backup/restore"
fi

for tool in pg_dump pg_restore psql gpg sha256sum mktemp date stat readlink grep sed awk git; do need_command "$tool"; done
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/factoryos-recovery.XXXXXX")"
partial_file="${backup_file}.partial.$$"
pg_dump_version="$(pg_dump --version | head -n 1)"
pg_restore_version="$(pg_restore --version | head -n 1)"
gpg_version="$(gpg --version | head -n 1)"

current_stage="database_identity"
source_identity="$(psql -w "service=$source_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" || die "could not establish source database identity"
target_identity="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" || die "could not establish restore target identity"
[[ -n "$source_identity" && -n "$target_identity" ]] || die "database identity check returned an empty identity"
[[ "$source_identity" != "$target_identity" ]] || die "source and restore target resolve to the same database identity"
distinct_database_identity=true
server_version="$(psql -w "service=$source_service" -X -qAt -v ON_ERROR_STOP=1 -c "SHOW server_version")" || die "could not read PostgreSQL server version"

target_relations="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' AND c.relkind IN ('r','p','v','m','S','f')")" || die "could not verify that the restore target is empty"
[[ "$target_relations" =~ ^[0-9]+$ ]] || die "restore target emptiness check returned an invalid count"
[[ "$target_relations" == "0" ]] || die "restore target contains user relations; no data was restored"
target_empty=true

run_watermark_query() {
  local service="$1" sql_file="$2" result
  result="$(psql -w "service=$service" -X -qAt -v ON_ERROR_STOP=1 -f "$sql_file")" || die "watermark query failed for service $service"
  result="$(printf '%s\n' "$result" | awk 'NF { value=$0 } END { print value }')"
  [[ "$result" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$ ]] || die "watermark SQL must return one UTC RFC 3339 timestamp"
  date -u -d "$result" +%s >/dev/null 2>&1 || die "watermark SQL returned an invalid timestamp"
  printf '%s' "$result"
}

read_single_marker() {
  local marker="$1" marker_file="$2" count value
  count="$(grep -c "^${marker}=" "$marker_file" || true)"
  [[ "$count" == "1" ]] || die "restore erasure SQL must emit exactly one ${marker} marker"
  value="$(sed -n "s/^${marker}=//p" "$marker_file")"
  [[ -n "$value" ]] || die "restore erasure SQL emitted an empty ${marker} marker"
  printf '%s' "$value"
}
if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  current_stage="source_watermark"
  source_watermark_utc="$(run_watermark_query "$source_service" "$watermark_sql")"
  candidate_manifest_sha256="$(sha256sum -- "$repo_root/$candidate_manifest" | awk '{print $1}')"
  declare -A seen_migrations=()
  while IFS= read -r migration || [[ -n "$migration" ]]; do
    migration="${migration%$'\r'}"
    [[ -z "$migration" || "$migration" =~ ^[[:space:]]*# ]] && continue
    [[ "$migration" =~ ^migrations/[0-9]{3}_[a-z0-9_]+\.sql$ ]] || die "invalid candidate migration entry: $migration"
    [[ -f "$repo_root/$migration" && -r "$repo_root/$migration" ]] || die "candidate migration does not exist: $migration"
    [[ -z "${seen_migrations[$migration]:-}" ]] || die "duplicate candidate migration: $migration"
    seen_migrations["$migration"]=1
    candidate_migration_count=$((candidate_migration_count + 1))
  done < "$repo_root/$candidate_manifest"
  if [[ "$manifest_mode" == "IDEMPOTENT_REPLAY" && "$candidate_migration_count" -eq 0 ]]; then
    die "idempotent replay manifest must contain at least one SQL entry"
  fi
fi

current_stage="encrypted_backup"
backup_started_epoch="$(epoch_now)"
printf 'Creating encrypted PostgreSQL custom-format backup...\n'
pg_dump --no-password --format=custom --no-owner --no-acl --dbname="service=$source_service" \
  | gpg --batch --yes --encrypt --recipient "$recipient" --output "$partial_file"
[[ -s "$partial_file" ]] || die "encrypted backup artifact is empty"
mv -- "$partial_file" "$backup_file"
partial_file=""
sha256sum -- "$backup_file" > "${backup_file}.sha256"
sha256sum --check "${backup_file}.sha256" >/dev/null || die "encrypted backup checksum verification failed"
checksum_sha256="$(sha256sum -- "$backup_file" | awk '{print $1}')"
checksum_verified=true
encryption_status="ENCRYPTED_GPG"
backup_duration_seconds="$(( $(epoch_now) - backup_started_epoch ))"

current_stage="archive_readability"
printf 'Decrypting to a private temporary directory and checking archive readability...\n'
gpg --batch --decrypt --output "$tmpdir/verified.dump" "$backup_file"
[[ -s "$tmpdir/verified.dump" ]] || die "decrypted database archive is empty"
pg_restore --list "$tmpdir/verified.dump" > "$tmpdir/archive-contents.txt" || die "pg_restore could not read the backup archive"
archive_status="READABLE"

current_stage="restore"
restore_started_epoch="$(epoch_now)"
printf 'Restoring into the separately verified empty database...\n'
pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="service=$target_service" "$tmpdir/verified.dump"
restore_status="RESTORED"

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  current_stage="candidate_migrations"
  psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 \
    -c "SELECT version FROM schema_migrations" > "$tmpdir/applied-migrations.txt" \
    || die "could not read restored schema_migrations"
  sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "$repo_root/scripts/audit/migration-manifest.txt" | tr -d '\r' > "$tmpdir/canonical-migrations.txt"
  sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "$repo_root/$candidate_manifest" | tr -d '\r' > "$tmpdir/requested-migrations.txt"

  if [[ "$manifest_mode" == "PENDING" ]]; then
    : > "$tmpdir/expected-pending-migrations.txt"
    while IFS= read -r canonical_migration || [[ -n "$canonical_migration" ]]; do
      canonical_base="${canonical_migration##*/}"
      canonical_version="${canonical_base%.sql}"
      if ! grep -Fxq -- "$canonical_version" "$tmpdir/applied-migrations.txt"; then
        printf '%s\n' "$canonical_migration" >> "$tmpdir/expected-pending-migrations.txt"
      fi
    done < "$tmpdir/canonical-migrations.txt"
    if ! cmp -s "$tmpdir/expected-pending-migrations.txt" "$tmpdir/requested-migrations.txt"; then
      diff -u "$tmpdir/expected-pending-migrations.txt" "$tmpdir/requested-migrations.txt" >&2 || true
      die "candidate manifest is not the exact ordered set pending from the restored source snapshot"
    fi
  elif [[ "$manifest_mode" == "IDEMPOTENT_REPLAY" ]]; then
    while IFS= read -r replay_migration || [[ -n "$replay_migration" ]]; do
      replay_migration="${replay_migration%$'\r'}"
      [[ -z "$replay_migration" ]] && continue
      replay_base="${replay_migration##*/}"
      replay_version="${replay_base%.sql}"
      grep -Fxq -- "$replay_migration" "$tmpdir/canonical-migrations.txt" || die "replay entry is not in the canonical migration manifest: $replay_migration"
      grep -Fxq -- "$replay_version" "$tmpdir/applied-migrations.txt" || die "replay entry is not already recorded as applied: $replay_migration"
    done < "$tmpdir/requested-migrations.txt"
  else
    die "FACTORYOS_MIGRATION_MANIFEST_MODE must be PENDING or IDEMPOTENT_REPLAY"
  fi

  candidate_migration_status="RUNNING"
  while IFS= read -r migration || [[ -n "$migration" ]]; do
    [[ -z "$migration" ]] && continue
    printf 'Applying candidate migration to isolated restore: %s\n' "$migration"
    psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$repo_root/$migration" 2>&1 | tee -a "$tmpdir/candidate-migrations.log"
  done < "$tmpdir/requested-migrations.txt"
  candidate_migration_status="PASS"

  current_stage="migration_failure_recovery"
  probe_relation="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN to_regclass('public.factoryos_migration_recovery_probe') IS NULL THEN 'absent' ELSE 'present' END")"
  [[ "$probe_relation" == "absent" ]] || die "recovery probe relation exists before rollback check"
  if psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$failure_probe_sql" > "$tmpdir/migration-failure-probe.log" 2>&1; then
    die "intentional failed-transaction probe unexpectedly succeeded"
  fi
  grep -qi "division by zero" "$tmpdir/migration-failure-probe.log" || { cat "$tmpdir/migration-failure-probe.log" >&2; die "failure-recovery probe returned an unexpected error"; }
  probe_relation="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN to_regclass('public.factoryos_migration_recovery_probe') IS NULL THEN 'absent' ELSE 'present' END")"
  [[ "$probe_relation" == "absent" ]] || die "failed migration left probe DDL in the restore target"
  failure_recovery_status="PASS"

  current_stage="restored_watermark"
  restored_watermark_utc="$(run_watermark_query "$target_service" "$watermark_sql")"
  event_epoch="$(date -u -d "$event_time_utc" +%s)"
  restored_watermark_epoch="$(date -u -d "$restored_watermark_utc" +%s)"
  (( restored_watermark_epoch <= event_epoch )) || die "event cutoff precedes the restored durable-write watermark"
  observed_rpo_seconds="$(( event_epoch - restored_watermark_epoch ))"
  current_stage="erasure_tombstone_replay"
  erasure_replay_sql_sha256="$(sha256sum -- "$erasure_replay_sql" | awk '{print $1}')"
  erasure_verify_sql_sha256="$(sha256sum -- "$erasure_verify_sql" | awk '{print $1}')"
  replay_log="$tmpdir/erasure-replay.log"
  verify_log="$tmpdir/erasure-verify.log"
  if ! psql -w "service=$target_service" -X -qAt -1 -v ON_ERROR_STOP=1 \
      -v "candidate_sha=$candidate_sha" \
      -v "target_database_identity=$target_identity" \
      -v "snapshot_watermark_utc=$restored_watermark_utc" \
      -v "incident_cutoff_utc=$event_time_utc" \
      -v "ledger_reference=$erasure_ledger_reference" \
      -v "ledger_sha256=$erasure_ledger_sha256" \
      -f "$erasure_replay_sql" > "$replay_log" 2>&1; then
    die "out-of-band erasure tombstone replay SQL failed; restore target remains quarantined"
  fi
  [[ "$(sha256sum -- "$erasure_replay_sql" | awk '{print $1}')" == "$erasure_replay_sql_sha256" ]] || die "erasure replay SQL changed while being executed"
  replay_status_marker="$(read_single_marker FACTORYOS_ERASURE_REPLAY_STATUS "$replay_log")"
  replay_ledger_marker="$(read_single_marker FACTORYOS_ERASURE_LEDGER_SHA256 "$replay_log")"
  replay_candidate_marker="$(read_single_marker FACTORYOS_ERASURE_REPLAY_CANDIDATE_SHA "$replay_log")"
  replay_target_marker="$(read_single_marker FACTORYOS_ERASURE_REPLAY_TARGET_IDENTITY "$replay_log")"
  erasure_ledger_watermark_utc="$(read_single_marker FACTORYOS_ERASURE_LEDGER_WATERMARK_UTC "$replay_log")"
  erasure_replayed_requests="$(read_single_marker FACTORYOS_ERASURE_REPLAYED_REQUESTS "$replay_log")"
  erasure_replay_residuals="$(read_single_marker FACTORYOS_ERASURE_REPLAY_RESIDUALS "$replay_log")"
  [[ "$replay_status_marker" == "PASS" ]] || die "erasure replay SQL did not report PASS"
  [[ "$replay_ledger_marker" == "$erasure_ledger_sha256" ]] || die "erasure replay ledger digest does not match the approved external ledger"
  [[ "$replay_candidate_marker" == "$candidate_sha" ]] || die "erasure replay receipt is bound to a different candidate SHA"
  [[ "$replay_target_marker" == "$target_identity" ]] || die "erasure replay receipt is bound to a different restore database"
  [[ "$erasure_replayed_requests" =~ ^(0|[1-9][0-9]*)$ ]] || die "erasure replay request count is invalid"
  [[ "$erasure_replay_residuals" == "0" ]] || die "erasure tombstone replay left unresolved residuals"
  [[ "$erasure_ledger_watermark_utc" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?Z$ ]] || die "erasure replay ledger watermark must be UTC RFC 3339"
  date -u -d "$erasure_ledger_watermark_utc" +%s >/dev/null 2>&1 || die "erasure replay ledger watermark is invalid"
  ledger_watermark_epoch="$(date -u -d "$erasure_ledger_watermark_utc" +%s)"
  current_epoch="$(epoch_now)"
  (( ledger_watermark_epoch >= event_epoch && ledger_watermark_epoch <= current_epoch )) || die "erasure tombstone ledger must cover the incident cutoff and cannot be from the future"

  current_stage="erasure_tombstone_verification"
  if ! PGOPTIONS="-c default_transaction_read_only=on" psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 \
      -v "candidate_sha=$candidate_sha" \
      -v "target_database_identity=$target_identity" \
      -v "snapshot_watermark_utc=$restored_watermark_utc" \
      -v "incident_cutoff_utc=$event_time_utc" \
      -v "ledger_reference=$erasure_ledger_reference" \
      -v "ledger_sha256=$erasure_ledger_sha256" \
      -f "$erasure_verify_sql" > "$verify_log" 2>&1; then
    die "independent read-only erasure replay verification SQL failed; restore target remains quarantined"
  fi
  [[ "$(sha256sum -- "$erasure_verify_sql" | awk '{print $1}')" == "$erasure_verify_sql_sha256" ]] || die "erasure verification SQL changed while being executed"
  verify_status_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_STATUS "$verify_log")"
  verify_ledger_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_LEDGER_SHA256 "$verify_log")"
  verify_candidate_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_CANDIDATE_SHA "$verify_log")"
  verify_target_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_TARGET_IDENTITY "$verify_log")"
  verify_requests_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_REPLAYED_REQUESTS "$verify_log")"
  verify_residuals_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_RESIDUALS "$verify_log")"
  verify_method_marker="$(read_single_marker FACTORYOS_ERASURE_VERIFY_METHOD "$verify_log")"
  [[ "$verify_status_marker" == "PASS" && "$verify_ledger_marker" == "$erasure_ledger_sha256" && "$verify_candidate_marker" == "$candidate_sha" && "$verify_target_marker" == "$target_identity" && "$verify_requests_marker" == "$erasure_replayed_requests" && "$verify_residuals_marker" == "0" && "$verify_method_marker" == "INDEPENDENT_READ_ONLY" ]] || die "independent erasure replay verification did not reconcile to the exact ledger, candidate and restore target"
  erasure_replay_status="PASS"
fi

current_stage="schema_smoke"
printf 'Running the reviewed restored-schema, tenant-isolation and audit smoke SQL...\n'
psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$smoke_sql" > "$tmpdir/restore-smoke.log" 2>&1 \
  || { cat "$tmpdir/restore-smoke.log" >&2; die "reviewed restore verification SQL failed"; }
cat "$tmpdir/restore-smoke.log"
if grep -q 'RECOVERY_SCHEMA_SMOKE=PASS' "$tmpdir/restore-smoke.log"; then schema_smoke_status="PASS"; fi
if grep -q 'RECOVERY_TENANT_ISOLATION=PASS' "$tmpdir/restore-smoke.log"; then tenant_isolation_status="PASS"; fi
if grep -q 'RECOVERY_AUDIT_CONTINUITY=PASS' "$tmpdir/restore-smoke.log"; then audit_continuity_status="PASS"; fi

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  [[ "$schema_smoke_status" == "PASS" ]] || die "smoke SQL did not prove restored application schema/data"
  [[ "$tenant_isolation_status" == "PASS" ]] || die "smoke SQL did not prove tenant isolation"
  [[ "$audit_continuity_status" == "PASS" ]] || die "smoke SQL did not prove audit continuity"

  current_stage="api_application_smoke"
  FACTORYOS_DR_APPLICATION_DATABASE_URL="$app_database_url" \
    FACTORYOS_DR_EXPECTED_DATABASE_IDENTITY="$target_identity" \
    node "$repo_root/scripts/recovery/application-restore-smoke.mjs" > "$tmpdir/api-restore-smoke.log" 2>&1 \
    || { cat "$tmpdir/api-restore-smoke.log" >&2; die "candidate API failed against the restored application database"; }
  cat "$tmpdir/api-restore-smoke.log"
  grep -q 'RECOVERY_API_READINESS=PASS' "$tmpdir/api-restore-smoke.log" || die "candidate API readiness marker is missing"
  grep -q 'RECOVERY_APPLICATION_SMOKE=PASS' "$tmpdir/api-restore-smoke.log" || die "candidate API application smoke marker is missing"
  api_readiness_status="PASS"
  application_smoke_status="PASS"
fi

restore_finished_epoch="$(epoch_now)"
restore_duration_seconds="$(( restore_finished_epoch - restore_started_epoch ))"
restore_status="PASS"
if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  event_epoch="$(date -u -d "$event_time_utc" +%s)"
  observed_rto_seconds="$(( restore_finished_epoch - event_epoch ))"
  if [[ "$targets_approved" == true ]]; then
    if (( observed_rpo_seconds > rpo_target_seconds || observed_rto_seconds > rto_target_seconds )); then
      target_assessment="BREACH_OF_APPROVED_TARGET"
      die "measured recovery exceeds owner-approved RPO/RTO"
    fi
    target_assessment="WITHIN_APPROVED_TARGETS"
  else
    target_assessment="NOT_APPROVED_NOT_CONTRACTUAL"
  fi
fi

current_stage="complete"
rehearsal_status="TECHNICAL_PASS"
printf 'BACKUP_RESTORE_REHEARSAL=TECHNICAL_PASS\n'
printf 'Source identity: %s\n' "$source_identity"
printf 'Restore target identity: %s\n' "$target_identity"
printf 'Encrypted backup SHA-256: %s\n' "$checksum_sha256"
printf 'Backup duration seconds: %s\n' "$backup_duration_seconds"
printf 'Restore and verification duration seconds: %s\n' "$restore_duration_seconds"
printf 'Observed RPO seconds: %s\n' "${observed_rpo_seconds:-NOT_MEASURED}"
printf 'Observed RTO seconds: %s\n' "${observed_rto_seconds:-NOT_MEASURED}"
printf 'Candidate migrations: %s (%s entries, mode %s)\n' "$candidate_migration_status" "$candidate_migration_count" "$manifest_mode"
printf 'Failure-recovery probe: %s\n' "$failure_recovery_status"
printf 'Schema smoke: %s; API smoke: %s; API readiness: %s; tenant isolation: %s; audit continuity: %s\n' "$schema_smoke_status" "$application_smoke_status" "$api_readiness_status" "$tenant_isolation_status" "$audit_continuity_status"
printf 'Erasure tombstone replay: %s; requests: %s; residuals: %s; ledger SHA-256: %s\n' "$erasure_replay_status" "${erasure_replayed_requests:-NOT_RUN}" "${erasure_replay_residuals:-NOT_RUN}" "${erasure_ledger_sha256:-NOT_SET}"
printf 'RPO/RTO target assessment: %s\n' "$target_assessment"
printf 'Operator sign-off is pending post-run review.\n'
\n'* ]] || die "restore erasure SQL emitted an empty or multi-line ${marker} marker"
  printf '%s' "$value"
}

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  current_stage="source_watermark"
  source_watermark_utc="$(run_watermark_query "$source_service" "$watermark_sql")"
  candidate_manifest_sha256="$(sha256sum -- "$repo_root/$candidate_manifest" | awk '{print $1}')"
  declare -A seen_migrations=()
  while IFS= read -r migration || [[ -n "$migration" ]]; do
    migration="${migration%$'\r'}"
    [[ -z "$migration" || "$migration" =~ ^[[:space:]]*# ]] && continue
    [[ "$migration" =~ ^migrations/[0-9]{3}_[a-z0-9_]+\.sql$ ]] || die "invalid candidate migration entry: $migration"
    [[ -f "$repo_root/$migration" && -r "$repo_root/$migration" ]] || die "candidate migration does not exist: $migration"
    [[ -z "${seen_migrations[$migration]:-}" ]] || die "duplicate candidate migration: $migration"
    seen_migrations["$migration"]=1
    candidate_migration_count=$((candidate_migration_count + 1))
  done < "$repo_root/$candidate_manifest"
  if [[ "$manifest_mode" == "IDEMPOTENT_REPLAY" && "$candidate_migration_count" -eq 0 ]]; then
    die "idempotent replay manifest must contain at least one SQL entry"
  fi
fi

current_stage="encrypted_backup"
backup_started_epoch="$(epoch_now)"
printf 'Creating encrypted PostgreSQL custom-format backup...\n'
pg_dump --no-password --format=custom --no-owner --no-acl --dbname="service=$source_service" \
  | gpg --batch --yes --encrypt --recipient "$recipient" --output "$partial_file"
[[ -s "$partial_file" ]] || die "encrypted backup artifact is empty"
mv -- "$partial_file" "$backup_file"
partial_file=""
sha256sum -- "$backup_file" > "${backup_file}.sha256"
sha256sum --check "${backup_file}.sha256" >/dev/null || die "encrypted backup checksum verification failed"
checksum_sha256="$(sha256sum -- "$backup_file" | awk '{print $1}')"
checksum_verified=true
encryption_status="ENCRYPTED_GPG"
backup_duration_seconds="$(( $(epoch_now) - backup_started_epoch ))"

current_stage="archive_readability"
printf 'Decrypting to a private temporary directory and checking archive readability...\n'
gpg --batch --decrypt --output "$tmpdir/verified.dump" "$backup_file"
[[ -s "$tmpdir/verified.dump" ]] || die "decrypted database archive is empty"
pg_restore --list "$tmpdir/verified.dump" > "$tmpdir/archive-contents.txt" || die "pg_restore could not read the backup archive"
archive_status="READABLE"

current_stage="restore"
restore_started_epoch="$(epoch_now)"
printf 'Restoring into the separately verified empty database...\n'
pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="service=$target_service" "$tmpdir/verified.dump"
restore_status="RESTORED"

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  current_stage="candidate_migrations"
  psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 \
    -c "SELECT version FROM schema_migrations" > "$tmpdir/applied-migrations.txt" \
    || die "could not read restored schema_migrations"
  sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "$repo_root/scripts/audit/migration-manifest.txt" | tr -d '\r' > "$tmpdir/canonical-migrations.txt"
  sed '/^[[:space:]]*#/d;/^[[:space:]]*$/d' "$repo_root/$candidate_manifest" | tr -d '\r' > "$tmpdir/requested-migrations.txt"

  if [[ "$manifest_mode" == "PENDING" ]]; then
    : > "$tmpdir/expected-pending-migrations.txt"
    while IFS= read -r canonical_migration || [[ -n "$canonical_migration" ]]; do
      canonical_base="${canonical_migration##*/}"
      canonical_version="${canonical_base%.sql}"
      if ! grep -Fxq -- "$canonical_version" "$tmpdir/applied-migrations.txt"; then
        printf '%s\n' "$canonical_migration" >> "$tmpdir/expected-pending-migrations.txt"
      fi
    done < "$tmpdir/canonical-migrations.txt"
    if ! cmp -s "$tmpdir/expected-pending-migrations.txt" "$tmpdir/requested-migrations.txt"; then
      diff -u "$tmpdir/expected-pending-migrations.txt" "$tmpdir/requested-migrations.txt" >&2 || true
      die "candidate manifest is not the exact ordered set pending from the restored source snapshot"
    fi
  elif [[ "$manifest_mode" == "IDEMPOTENT_REPLAY" ]]; then
    while IFS= read -r replay_migration || [[ -n "$replay_migration" ]]; do
      replay_migration="${replay_migration%$'\r'}"
      [[ -z "$replay_migration" ]] && continue
      replay_base="${replay_migration##*/}"
      replay_version="${replay_base%.sql}"
      grep -Fxq -- "$replay_migration" "$tmpdir/canonical-migrations.txt" || die "replay entry is not in the canonical migration manifest: $replay_migration"
      grep -Fxq -- "$replay_version" "$tmpdir/applied-migrations.txt" || die "replay entry is not already recorded as applied: $replay_migration"
    done < "$tmpdir/requested-migrations.txt"
  else
    die "FACTORYOS_MIGRATION_MANIFEST_MODE must be PENDING or IDEMPOTENT_REPLAY"
  fi

  candidate_migration_status="RUNNING"
  while IFS= read -r migration || [[ -n "$migration" ]]; do
    [[ -z "$migration" ]] && continue
    printf 'Applying candidate migration to isolated restore: %s\n' "$migration"
    psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$repo_root/$migration" 2>&1 | tee -a "$tmpdir/candidate-migrations.log"
  done < "$tmpdir/requested-migrations.txt"
  candidate_migration_status="PASS"

  current_stage="migration_failure_recovery"
  probe_relation="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN to_regclass('public.factoryos_migration_recovery_probe') IS NULL THEN 'absent' ELSE 'present' END")"
  [[ "$probe_relation" == "absent" ]] || die "recovery probe relation exists before rollback check"
  if psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$failure_probe_sql" > "$tmpdir/migration-failure-probe.log" 2>&1; then
    die "intentional failed-transaction probe unexpectedly succeeded"
  fi
  grep -qi "division by zero" "$tmpdir/migration-failure-probe.log" || { cat "$tmpdir/migration-failure-probe.log" >&2; die "failure-recovery probe returned an unexpected error"; }
  probe_relation="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT CASE WHEN to_regclass('public.factoryos_migration_recovery_probe') IS NULL THEN 'absent' ELSE 'present' END")"
  [[ "$probe_relation" == "absent" ]] || die "failed migration left probe DDL in the restore target"
  failure_recovery_status="PASS"

  current_stage="restored_watermark"
  restored_watermark_utc="$(run_watermark_query "$target_service" "$watermark_sql")"
  event_epoch="$(date -u -d "$event_time_utc" +%s)"
  restored_watermark_epoch="$(date -u -d "$restored_watermark_utc" +%s)"
  (( restored_watermark_epoch <= event_epoch )) || die "event cutoff precedes the restored durable-write watermark"
  observed_rpo_seconds="$(( event_epoch - restored_watermark_epoch ))"
fi

current_stage="schema_smoke"
printf 'Running the reviewed restored-schema, tenant-isolation and audit smoke SQL...\n'
psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$smoke_sql" > "$tmpdir/restore-smoke.log" 2>&1 \
  || { cat "$tmpdir/restore-smoke.log" >&2; die "reviewed restore verification SQL failed"; }
cat "$tmpdir/restore-smoke.log"
if grep -q 'RECOVERY_SCHEMA_SMOKE=PASS' "$tmpdir/restore-smoke.log"; then schema_smoke_status="PASS"; fi
if grep -q 'RECOVERY_TENANT_ISOLATION=PASS' "$tmpdir/restore-smoke.log"; then tenant_isolation_status="PASS"; fi
if grep -q 'RECOVERY_AUDIT_CONTINUITY=PASS' "$tmpdir/restore-smoke.log"; then audit_continuity_status="PASS"; fi

if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  [[ "$schema_smoke_status" == "PASS" ]] || die "smoke SQL did not prove restored application schema/data"
  [[ "$tenant_isolation_status" == "PASS" ]] || die "smoke SQL did not prove tenant isolation"
  [[ "$audit_continuity_status" == "PASS" ]] || die "smoke SQL did not prove audit continuity"

  current_stage="api_application_smoke"
  FACTORYOS_DR_APPLICATION_DATABASE_URL="$app_database_url" \
    FACTORYOS_DR_EXPECTED_DATABASE_IDENTITY="$target_identity" \
    node "$repo_root/scripts/recovery/application-restore-smoke.mjs" > "$tmpdir/api-restore-smoke.log" 2>&1 \
    || { cat "$tmpdir/api-restore-smoke.log" >&2; die "candidate API failed against the restored application database"; }
  cat "$tmpdir/api-restore-smoke.log"
  grep -q 'RECOVERY_API_READINESS=PASS' "$tmpdir/api-restore-smoke.log" || die "candidate API readiness marker is missing"
  grep -q 'RECOVERY_APPLICATION_SMOKE=PASS' "$tmpdir/api-restore-smoke.log" || die "candidate API application smoke marker is missing"
  api_readiness_status="PASS"
  application_smoke_status="PASS"
fi

restore_finished_epoch="$(epoch_now)"
restore_duration_seconds="$(( restore_finished_epoch - restore_started_epoch ))"
restore_status="PASS"
if [[ "$dr_mode" == "RELEASE_GATE" ]]; then
  event_epoch="$(date -u -d "$event_time_utc" +%s)"
  observed_rto_seconds="$(( restore_finished_epoch - event_epoch ))"
  if [[ "$targets_approved" == true ]]; then
    if (( observed_rpo_seconds > rpo_target_seconds || observed_rto_seconds > rto_target_seconds )); then
      target_assessment="BREACH_OF_APPROVED_TARGET"
      die "measured recovery exceeds owner-approved RPO/RTO"
    fi
    target_assessment="WITHIN_APPROVED_TARGETS"
  else
    target_assessment="NOT_APPROVED_NOT_CONTRACTUAL"
  fi
fi

current_stage="complete"
rehearsal_status="TECHNICAL_PASS"
printf 'BACKUP_RESTORE_REHEARSAL=TECHNICAL_PASS\n'
printf 'Source identity: %s\n' "$source_identity"
printf 'Restore target identity: %s\n' "$target_identity"
printf 'Encrypted backup SHA-256: %s\n' "$checksum_sha256"
printf 'Backup duration seconds: %s\n' "$backup_duration_seconds"
printf 'Restore and verification duration seconds: %s\n' "$restore_duration_seconds"
printf 'Observed RPO seconds: %s\n' "${observed_rpo_seconds:-NOT_MEASURED}"
printf 'Observed RTO seconds: %s\n' "${observed_rto_seconds:-NOT_MEASURED}"
printf 'Candidate migrations: %s (%s entries, mode %s)\n' "$candidate_migration_status" "$candidate_migration_count" "$manifest_mode"
printf 'Failure-recovery probe: %s\n' "$failure_recovery_status"
printf 'Schema smoke: %s; API smoke: %s; API readiness: %s; tenant isolation: %s; audit continuity: %s\n' "$schema_smoke_status" "$application_smoke_status" "$api_readiness_status" "$tenant_isolation_status" "$audit_continuity_status"
printf 'RPO/RTO target assessment: %s\n' "$target_assessment"
printf 'Operator sign-off is pending post-run review.\n'
