#!/usr/bin/env bash
# Encrypted, operator-confirmed PostgreSQL backup/restore rehearsal.
# Credentials belong in protected libpq service/pgpass files, never in this script.
set -Eeuo pipefail
umask 077

die() { printf 'recovery rehearsal failed: %s\n' "$*" >&2; exit 1; }
need_command() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
need_value() {
  local name="$1" value="${2:-}"
  [[ -n "$value" ]] || die "required environment variable is missing: $name"
}

source_service="${FACTORYOS_BACKUP_PGSERVICE:-}"
target_service="${FACTORYOS_RESTORE_PGSERVICE:-}"
backup_file="${FACTORYOS_BACKUP_OUTPUT:-}"
recipient="${FACTORYOS_BACKUP_GPG_RECIPIENT:-}"
smoke_sql="${FACTORYOS_RESTORE_SMOKE_SQL:-}"
dr_mode="${FACTORYOS_DR_MODE:-BASIC}"
candidate_manifest="${FACTORYOS_CANDIDATE_MIGRATION_MANIFEST:-}"
watermark_sql="${FACTORYOS_RECOVERY_WATERMARK_SQL:-}"
failure_probe_sql="${FACTORYOS_MIGRATION_FAILURE_PROBE_SQL:-$repo_root/services/api/test/migration-recovery-failure.sql}"
evidence_file="${FACTORYOS_RECOVERY_EVIDENCE_JSON:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
current_stage="configuration"
rehearsal_status="RUNNING"
started_at_utc="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
started_epoch="$(date -u '+%s')"
backup_started_epoch=""
backup_duration_seconds=""
restore_started_epoch=""
restore_duration_seconds=""
source_identity=""
target_identity=""
source_watermark_utc=""
restored_watermark_utc=""
event_time_utc="${FACTORYOS_RECOVERY_EVENT_TIME_UTC:-}"
observed_rpo_seconds=""
observed_rto_seconds=""
candidate_manifest_sha256=""
candidate_migration_count=0
candidate_migration_status="NOT_RUN"
failure_recovery_status="NOT_RUN"
application_smoke_status="NOT_REPORTED"
tenant_isolation_status="NOT_REPORTED"
audit_continuity_status="NOT_REPORTED"
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

need_value FACTORYOS_BACKUP_PGSERVICE "$source_service"
need_value FACTORYOS_RESTORE_PGSERVICE "$target_service"
need_value FACTORYOS_BACKUP_OUTPUT "$backup_file"
need_value FACTORYOS_BACKUP_GPG_RECIPIENT "$recipient"
need_value FACTORYOS_RESTORE_SMOKE_SQL "$smoke_sql"

[[ "$source_service" =~ ^[A-Za-z0-9_.-]{1,63}$ ]] || die "backup service name contains unsupported characters"
[[ "$target_service" =~ ^[A-Za-z0-9_.-]{1,63}$ ]] || die "restore service name contains unsupported characters"
[[ "$source_service" != "$target_service" ]] || die "backup and restore service names must differ"
[[ "$backup_file" == /* ]] || die "FACTORYOS_BACKUP_OUTPUT must be an absolute path"
[[ "$backup_file" == *.dump.gpg ]] || die "backup output must end in .dump.gpg (encrypted custom-format archive)"
[[ -d "$(dirname "$backup_file")" ]] || die "backup output directory must already exist on approved restricted storage"
[[ ! -e "$backup_file" && ! -L "$backup_file" ]] || die "backup output already exists; refusing to overwrite recovery evidence"
[[ ! -e "${backup_file}.sha256" && ! -L "${backup_file}.sha256" ]] || die "checksum output already exists; refusing to overwrite recovery evidence"
[[ -f "$smoke_sql" && -r "$smoke_sql" ]] || die "FACTORYOS_RESTORE_SMOKE_SQL must name a readable, reviewed restore-verification SQL file"
[[ "${FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE:-}" == "I_HAVE_VERIFIED_EMPTY" ]] || die "set FACTORYOS_RESTORE_CONFIRM_EMPTY_DATABASE=I_HAVE_VERIFIED_EMPTY only after confirming the restore target is disposable and isolated"

for tool in pg_dump pg_restore psql gpg sha256sum mktemp; do need_command "$tool"; done

emit_evidence() {
  local exit_code="$1"
  [[ -n "$evidence_file" ]] || return 0
  need_command node
  export FACTORYOS_DR_STATUS="$rehearsal_status" FACTORYOS_DR_STAGE="$current_stage"
  export FACTORYOS_DR_EXIT_CODE="$exit_code" FACTORYOS_DR_STARTED_AT_UTC="$started_at_utc"
  export FACTORYOS_DR_SOURCE_IDENTITY="$source_identity" FACTORYOS_DR_TARGET_IDENTITY="$target_identity"
  export FACTORYOS_DR_DATABASE_IDENTITIES_DISTINCT="$distinct_database_identity" FACTORYOS_DR_TARGET_EMPTY="$target_empty"
  export FACTORYOS_DR_BACKUP_SHA256="$checksum_sha256" FACTORYOS_DR_CHECKSUM_VERIFIED="$checksum_verified"
  export FACTORYOS_DR_ENCRYPTION_STATUS="$encryption_status" FACTORYOS_DR_ARCHIVE_STATUS="$archive_status"
  export FACTORYOS_DR_RESTORE_STATUS="$restore_status" FACTORYOS_DR_APPLICATION_SMOKE_STATUS="$application_smoke_status"
  export FACTORYOS_DR_TENANT_ISOLATION_STATUS="$tenant_isolation_status" FACTORYOS_DR_AUDIT_CONTINUITY_STATUS="$audit_continuity_status"
  export FACTORYOS_DR_CANDIDATE_MIGRATION_MANIFEST="$candidate_manifest" FACTORYOS_DR_CANDIDATE_MANIFEST_SHA256="$candidate_manifest_sha256"
  export FACTORYOS_DR_CANDIDATE_MIGRATION_COUNT="$candidate_migration_count" FACTORYOS_DR_CANDIDATE_MIGRATION_STATUS="$candidate_migration_status"
  export FACTORYOS_DR_FAILURE_RECOVERY_STATUS="$failure_recovery_status"
  export FACTORYOS_DR_BACKUP_DURATION_SECONDS="$backup_duration_seconds" FACTORYOS_DR_RESTORE_DURATION_SECONDS="$restore_duration_seconds"
  export FACTORYOS_DR_SOURCE_WATERMARK_UTC="$source_watermark_utc" FACTORYOS_DR_RESTORED_WATERMARK_UTC="$restored_watermark_utc"
  export FACTORYOS_DR_EVENT_TIME_UTC="$event_time_utc" FACTORYOS_DR_OBSERVED_RPO_SECONDS="$observed_rpo_seconds"
  export FACTORYOS_DR_OBSERVED_RTO_SECONDS="$observed_rto_seconds" FACTORYOS_DR_TARGETS_APPROVED="$targets_approved"
  export FACTORYOS_DR_RPO_TARGET_SECONDS="$rpo_target_seconds" FACTORYOS_DR_RTO_TARGET_SECONDS="$rto_target_seconds"
  export FACTORYOS_DR_TARGET_ASSESSMENT="$target_assessment" FACTORYOS_DR_OPERATOR="${FACTORYOS_RECOVERY_OPERATOR:-}"
  export FACTORYOS_DR_APPROVER="${FACTORYOS_RECOVERY_APPROVER:-}" FACTORYOS_DR_PG_DUMP_VERSION="$pg_dump_version"
  export FACTORYOS_DR_PG_RESTORE_VERSION="$pg_restore_version" FACTORYOS_DR_SERVER_VERSION="$server_version"
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

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/factoryos-recovery.XXXXXX")"
partial_file="${backup_file}.partial.$"

source_identity="$(psql -w "service=$source_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" \
  || die "could not establish source database identity"
target_identity="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" \
  || die "could not establish restore target identity"
[[ -n "$source_identity" && -n "$target_identity" ]] || die "database identity check returned an empty identity"
[[ "$source_identity" != "$target_identity" ]] || die "source and restore target resolve to the same database identity"

target_relations="$(psql -w "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' AND c.relkind IN ('r','p','v','m','S','f')")" \
  || die "could not verify that the restore target is empty"
[[ "$target_relations" =~ ^[0-9]+$ ]] || die "restore target emptiness check returned an invalid count"
[[ "$target_relations" == "0" ]] || die "restore target contains user relations; no data was restored"

printf 'Creating encrypted PostgreSQL custom-format backup...\n'
pg_dump --no-password --format=custom --no-owner --no-acl --dbname="service=$source_service" \
  | gpg --batch --yes --encrypt --recipient "$recipient" --output "$partial_file"

[[ -s "$partial_file" ]] || die "encrypted backup artifact is empty"
mv -- "$partial_file" "$backup_file"
sha256sum -- "$backup_file" > "${backup_file}.sha256"
sha256sum --check "${backup_file}.sha256" >/dev/null || die "encrypted backup checksum verification failed"

printf 'Decrypting to a private temporary directory and checking archive readability...\n'
gpg --batch --decrypt --output "$tmpdir/verified.dump" "$backup_file"
[[ -s "$tmpdir/verified.dump" ]] || die "decrypted database archive is empty"
pg_restore --list "$tmpdir/verified.dump" > "$tmpdir/archive-contents.txt" \
  || die "pg_restore could not read the backup archive"

printf 'Restoring into the separately verified empty database...\n'
pg_restore --no-password --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="service=$target_service" "$tmpdir/verified.dump"

printf 'Running the reviewed restore-verification SQL...\n'
psql -w "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$smoke_sql" >/dev/null

printf 'BACKUP_RESTORE_REHEARSAL=PASS\n'
printf 'Encrypted artifact: %s\n' "$backup_file"
printf 'Checksum file: %s.sha256\n' "$backup_file"
printf 'Restore target database: %s\n' "${target_identity%%|*}"
printf 'Restore verification SQL: %s\n' "$smoke_sql"
printf 'The operator must store the candidate SHA, backup timestamp, pg_dump/pg_restore versions, elapsed restore time, RPO/RTO observations and approval in the change record.\n'
