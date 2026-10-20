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

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/factoryos-recovery.XXXXXX")"
partial_file="${backup_file}.partial.$$"
cleanup() {
  rm -f -- "$partial_file"
  rm -rf -- "$tmpdir"
}
trap cleanup EXIT HUP INT TERM

source_identity="$(psql "service=$source_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" \
  || die "could not establish source database identity"
target_identity="$(psql "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT current_database() || '|' || COALESCE(inet_server_addr()::text, 'local') || '|' || COALESCE(inet_server_port()::text, 'local')")" \
  || die "could not establish restore target identity"
[[ -n "$source_identity" && -n "$target_identity" ]] || die "database identity check returned an empty identity"
[[ "$source_identity" != "$target_identity" ]] || die "source and restore target resolve to the same database identity"

target_relations="$(psql "service=$target_service" -X -qAt -v ON_ERROR_STOP=1 -c "SELECT COUNT(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp_' AND c.relkind IN ('r','p','v','m','S','f')")" \
  || die "could not verify that the restore target is empty"
[[ "$target_relations" =~ ^[0-9]+$ ]] || die "restore target emptiness check returned an invalid count"
[[ "$target_relations" == "0" ]] || die "restore target contains user relations; no data was restored"

printf 'Creating encrypted PostgreSQL custom-format backup...\n'
pg_dump --format=custom --no-owner --no-acl --dbname="service=$source_service" \
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
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname="service=$target_service" "$tmpdir/verified.dump"

printf 'Running the reviewed restore-verification SQL...\n'
psql "service=$target_service" -X -v ON_ERROR_STOP=1 -f "$smoke_sql" >/dev/null

printf 'BACKUP_RESTORE_REHEARSAL=PASS\n'
printf 'Encrypted artifact: %s\n' "$backup_file"
printf 'Checksum file: %s.sha256\n' "$backup_file"
printf 'Restore target database: %s\n' "${target_identity%%|*}"
printf 'Restore verification SQL: %s\n' "$smoke_sql"
printf 'The operator must store the candidate SHA, backup timestamp, pg_dump/pg_restore versions, elapsed restore time, RPO/RTO observations and approval in the change record.\n'
