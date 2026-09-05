#!/usr/bin/env bash
# Native Alpine guest lifecycle. Sourceable functions keep failure paths testable
# without requiring a real Proxmox guest or privileged test process.
set -Eeuo pipefail
umask 077

ETC_DIR=/etc/miaoyomi
STATE_DIR=/var/lib/miaoyomi
APP_DIR=/opt/miaoyomi
RELEASES_DIR=$APP_DIR/releases
BACKUPS_DIR=/var/backups/miaoyomi
LOG_DIR=/var/log/miaoyomi
INIT_DIR=/etc/init.d
PG_CONF_DIR=/etc/postgresql
PG_DATA_DIR=/var/lib/postgresql/18/data
APK_REPOSITORIES=/etc/apk/repositories
MANAGER_PATH=/usr/local/sbin/miaoyomi
READINESS_ATTEMPTS=90
SUWAYOMI_PIN=v2.3.2243
SUWAYOMI_DIGEST=821141b32e170d4a02d3cbdfed577ed8f07bd22383ff5f4132ebb5ae40e98dd5
PHASE=idle
NEW_RELEASE=
NEW_MANAGER=
PREVIOUS_RELEASE=
LAST_BACKUP=
RUNNING_WRITERS=()
LOCK_HELD=no

say() { printf '[miaoyomi] %s\n' "$*" >&2; }
die() { say "$*"; return 1; }
usage() {
  cat <<'USAGE'
Usage: miaoyomi COMMAND [OPTIONS]
  install --source-dir DIR --config FILE   Install in a fresh Alpine 3.24 guest
  update [--source-dir DIR] [--ref REF]     Build, back up, then switch app release
  update-suwayomi --version vX.Y.Z --sha256 SHA256
  set-solver --url ORIGIN [--ctid ID]        Check and connect an external FlareSolverr
                                          Use --url '' to disable the integration
  backup [--output NEW_DIRECTORY]          Stop writers for a complete native backup
  status                                  Show native services and active release
  logs [app|novel|suwayomi|postgres|solver]  Follow a service log (default: app)
  restart                                 Restart native writers, then check readiness

Local-source installations need --source-dir for every app update. Git installations
use their saved HTTPS repository/ref unless a replacement source directory is given.
Application updates do not upgrade Alpine, PostgreSQL, Suwayomi or system packages.
USAGE
}

require_platform() {
  [[ $(id -u) == 0 ]] || die 'Run this command as root inside the LXC guest.'
  [[ -f /etc/alpine-release && $(cat /etc/alpine-release) == 3.24.* ]] || die 'This installer requires Alpine 3.24; it never changes the OS release.'
  [[ $(uname -m) == x86_64 ]] || die 'This installer supports x86_64 guests.'
}

require_root_file() {
  local file=$1 mode
  [[ -f "$file" && ! -L "$file" ]] || die "Expected a regular root-owned configuration file: $file"
  [[ $(stat -c '%u' "$file") == 0 ]] || die "Configuration must be owned by root: $file"
  mode=$(stat -c '%a' "$file")
  (( (8#$mode & 8#022) == 0 )) || die "Configuration must not be writable by group/others: $file"
}

validate_solver() {
  local url=$1 ctid=$2 port host label
  if [[ -n "$url" ]]; then
    [[ "$url" =~ ^https?://([A-Za-z0-9.-]+)(:([0-9]+))?$ ]] || die 'FLARESOLVERR_URL must be an HTTP(S) origin with no credentials, path, query, whitespace or trailing slash.'
    host=${BASH_REMATCH[1]}
    port=${BASH_REMATCH[3]:-}
    [[ ${#host} -le 253 && "$host" != *..* ]] || die 'Invalid hostname in FLARESOLVERR_URL.'
    local labels=()
    IFS=. read -r -a labels <<< "$host"
    for label in "${labels[@]}"; do
      [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ && ${#label} -le 63 ]] || die 'Invalid hostname in FLARESOLVERR_URL.'
    done
    if [[ -n "$port" ]]; then
      if [[ ${#port} -gt 5 ]] || ((10#$port < 1 || 10#$port > 65535)); then die 'FLARESOLVERR_URL port must be between 1 and 65535.'; fi
    fi
  fi
  [[ -z "$ctid" || ( "$ctid" =~ ^[1-9][0-9]*$ && ${#ctid} -le 9 ) ]] || die 'FLARESOLVERR_CTID must be an optional numeric container ID.'
}

solver_healthy() {
  local url=$1
  curl --fail --silent --show-error --proto '=http,https' --max-time 5 "$url/" 2>/dev/null |
    node -e 'try { const value = JSON.parse(require("node:fs").readFileSync(0, "utf8")); process.exit(value.msg === "FlareSolverr is ready!" && typeof value.version === "string" && value.version.length > 0 ? 0 : 1); } catch { process.exit(1); }'
}

solver_status() {
  if [[ -z "$FLARESOLVERR_URL" ]]; then printf 'FlareSolverr: disabled\n'; return; fi
  printf 'FlareSolverr (external%s): %s — ' "${FLARESOLVERR_CTID:+, LXC $FLARESOLVERR_CTID}" "$FLARESOLVERR_URL"
  if solver_healthy "$FLARESOLVERR_URL"; then printf 'healthy\n'; else printf 'unreachable or unhealthy\n'; return 1; fi
}

# Update one managed key without re-sourcing or regenerating unrelated secrets
# and settings. Preserve the original owner and mode on atomic replacement.
set_environment_key() {
  local file=$1 key=$2 value=$3 line temporary=$1.tmp.$$ found=no
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "Temporary configuration already exists: $temporary"
  if [[ -e "$file" || -L "$file" ]]; then
    require_root_file "$file"
    cp -p "$file" "$temporary"
  else
    : > "$file"
    chmod 600 "$file"
    cp -p "$file" "$temporary"
  fi
  {
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?$key= ]]; then
        if [[ "$found" == no ]]; then write_env_line "$key" "$value"; found=yes; fi
      else
        printf '%s\n' "$line"
      fi
    done < "$file"
    if [[ "$found" == no ]]; then write_env_line "$key" "$value"; fi
  } > "$temporary"
  mv -f "$temporary" "$file"
}

write_solver_environment() {
  local arguments='-Dsuwayomi.tachidesk.config.server.flareSolverrEnabled=false'
  if [[ -n "$FLARESOLVERR_URL" ]]; then
    arguments="-Dsuwayomi.tachidesk.config.server.flareSolverrEnabled=true -Dsuwayomi.tachidesk.config.server.flareSolverrUrl=$FLARESOLVERR_URL"
  fi
  set_environment_key "$ETC_DIR/suwayomi-solver.env" SUWAYOMI_SOLVER_ARGS "$arguments"
}

set_solver() {
  local url=$1 ctid=$2
  require_installed
  require_recovered
  validate_solver "$url" "$ctid"
  acquire_lock
  if [[ -n "$url" ]]; then
    say "Checking external FlareSolverr from this guest: $url"
    solver_healthy "$url" || die 'External FlareSolverr is unreachable or returned an unexpected health response; configuration has not changed.'
  else
    ctid=
  fi
  PREVIOUS_RELEASE=$(readlink "$APP_DIR/current")
  NEW_RELEASE=$PREVIOUS_RELEASE
  PHASE=before-cutover
  stop_writers
  perform_backup
  PHASE=cutover
  FLARESOLVERR_URL=$url
  FLARESOLVERR_CTID=$ctid
  set_environment_key "$ETC_DIR/app.env" FLARESOLVERR_URL "$url"
  set_environment_key "$ETC_DIR/novel.env" FLARESOLVERR_URL "$url"
  write_solver_environment
  set_environment_key "$ETC_DIR/install.conf" FLARESOLVERR_URL "$url"
  set_environment_key "$ETC_DIR/install.conf" FLARESOLVERR_CTID "$ctid"
  start_writers
  PHASE=idle
  say "External FlareSolverr configuration updated. Backup: $LAST_BACKUP"
}

load_install_config() {
  local file=$1
  require_root_file "$file"
  PUBLIC_ORIGIN='' WEB_PORT='' SOURCE_REPO='' SOURCE_REF='' MANGA_LIBRARY_PATH='' FLARESOLVERR_URL='' FLARESOLVERR_CTID=''
  # Host wizard generates this root-owned file using Bash %q quoting.
  # shellcheck disable=SC1090
  source "$file"
  [[ "$PUBLIC_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die 'PUBLIC_ORIGIN must be an HTTPS origin, without a path or trailing slash.'
  if [[ ! "$WEB_PORT" =~ ^[0-9]+$ || ${#WEB_PORT} -gt 5 ]] || ((10#$WEB_PORT < 1024 || 10#$WEB_PORT > 65535)); then die 'WEB_PORT must be between 1024 and 65535.'; fi
  case "$WEB_PORT" in 4100|4567|5432) die 'WEB_PORT conflicts with a private service.';; esac
  [[ -z "$SOURCE_REPO" || "$SOURCE_REPO" =~ ^https://[^[:space:]]+$ ]] || die 'SOURCE_REPO must be an HTTPS Git URL.'
  [[ "$SOURCE_REPO" != *'@'* ]] || die 'Do not store credentials in SOURCE_REPO; use a credential-free HTTPS repository.'
  [[ "$SOURCE_REF" != -* && "$SOURCE_REF" != *$'\n'* && "$SOURCE_REF" != *$'\r'* ]] || die 'Invalid Git ref.'
  [[ -z "$MANGA_LIBRARY_PATH" || ( "$MANGA_LIBRARY_PATH" == /* && "$MANGA_LIBRARY_PATH" != *$'\n'* && "$MANGA_LIBRARY_PATH" != *$'\r'* ) ]] || die 'MANGA_LIBRARY_PATH must be an absolute guest path.'
  validate_solver "$FLARESOLVERR_URL" "$FLARESOLVERR_CTID"
}

write_install_config() {
  local target=$ETC_DIR/install.conf.tmp.$$ key
  [[ ! -e "$target" && ! -L "$target" ]] || die "Temporary installation configuration already exists: $target"
  if [[ -f "$ETC_DIR/install.conf" ]]; then
    require_root_file "$ETC_DIR/install.conf"
    cp -p "$ETC_DIR/install.conf" "$target"
  else
    : > "$target"
  fi
  for key in PUBLIC_ORIGIN WEB_PORT SOURCE_REPO SOURCE_REF MANGA_LIBRARY_PATH FLARESOLVERR_URL FLARESOLVERR_CTID; do set_environment_key "$target" "$key" "${!key}"; done
  chmod 600 "$target"
  mv -f "$target" "$ETC_DIR/install.conf"
}

require_installed() {
  [[ -f "$ETC_DIR/installed" && -L "$APP_DIR/current" ]] || die 'No complete native installation found; use install first.'
  load_install_config "$ETC_DIR/install.conf"
}

require_recovered() {
  [[ ! -f "$ETC_DIR/recovery-required" ]] || die "A previous cutover failed. Review $ETC_DIR/recovery-required and the preserved backup before removing that marker manually."
}

acquire_lock() {
  mkdir -p "$ETC_DIR"
  mkdir "$ETC_DIR/operation.lock" 2>/dev/null || die "Another operation is active (or was interrupted): $ETC_DIR/operation.lock. Check its pid before removing a stale lock."
  LOCK_HELD=yes
  printf '%s\n' "$$" > "$ETC_DIR/operation.lock/pid"
}

release_lock() {
  if [[ "$LOCK_HELD" == yes ]]; then rm -f "$ETC_DIR/operation.lock/pid"; rmdir "$ETC_DIR/operation.lock" 2>/dev/null || true; fi
}

writers() {
  printf '%s\n' miaoyomi miaoyomi-novel miaoyomi-suwayomi
}

resume_previous_writers() {
  local index
  for ((index=${#RUNNING_WRITERS[@]}-1; index>=0; index--)); do rc-service "${RUNNING_WRITERS[index]}" start || return; done
}

on_failure() {
  local status=${1:-$?}
  trap - ERR INT TERM
  set +e
  case "$PHASE" in
    before-cutover|backup)
      say 'Operation failed before cutover; resuming services from the unchanged release.'
      resume_previous_writers || say 'A previous service could not be resumed; inspect service status and logs.'
      ;;
    cutover)
      local service
      while IFS= read -r service; do rc-service "$service" stop; done < <(writers)
      {
        printf 'A cutover failed at %s. Writers have been stopped.\n' "$(date -u +%FT%TZ)"
        printf 'Previous release: %s\nSelected release: %s\nBackup: %s\n' "$PREVIOUS_RELEASE" "$NEW_RELEASE" "$LAST_BACKUP"
        printf 'Do not roll code back across database migrations. Inspect logs and either repair forward or restore the matching database and files together.\n'
      } > "$ETC_DIR/recovery-required"
      chmod 600 "$ETC_DIR/recovery-required"
      say "Cutover failed; no automatic rollback was performed. See $ETC_DIR/recovery-required."
      ;;
  esac
  say "Command failed (phase: $PHASE). Source releases and any backup have been preserved."
  exit "$status"
}

stop_writers() {
  local service
  RUNNING_WRITERS=()
  # Capture the complete set before stopping any service, so a stop failure can
  # resume the already-stopped services without starting previously inactive ones.
  while IFS= read -r service; do
    if rc-service "$service" status >/dev/null 2>&1; then RUNNING_WRITERS+=("$service"); fi
  done < <(writers)
  for service in "${RUNNING_WRITERS[@]}"; do rc-service "$service" stop; done
}

wait_url() {
  local url=$1 label=$2 attempt
  for ((attempt=1; attempt<=READINESS_ATTEMPTS; attempt++)); do
    if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then return; fi
    sleep 2
  done
  die "$label did not become ready at $url. Inspect its log."
}

start_writers() {
  # The remote solver is optional at boot: local libraries remain usable during
  # its maintenance or a different container's slower reboot.
  rc-service miaoyomi-suwayomi start
  wait_url http://127.0.0.1:4567/api/v1/settings/about Suwayomi
  rc-service miaoyomi-novel start
  wait_url http://127.0.0.1:4100/healthz 'Novel engine'
  rc-service miaoyomi start
  wait_url "http://127.0.0.1:$WEB_PORT/healthz" Miaoyomi
  wait_url "http://127.0.0.1:$WEB_PORT/" 'Static frontend'
}

validate_source() {
  local dir=$1 file
  [[ -d "$dir" ]] || die "Source directory does not exist: $dir"
  for file in bff/package.json bff/package-lock.json bff/src/server.ts bff/openapi.yaml web/package.json web/package-lock.json web/next.config.mjs novel-engine/package.json novel-engine/package-lock.json novel-engine/src/server.mjs novel-engine/scripts/build.mjs novel-engine/vendor/registry.json; do
    [[ -f "$dir/$file" && ! -L "$dir/$file" ]] || die "Source tree is missing a regular $file; provide the Miaoyomi downstream checkout."
  done
}

stage_manager() {
  local source=$1 candidate=$1/scripts/proxmox/miaoyomi-native.sh help
  NEW_MANAGER=
  if [[ ! -e "$candidate" && ! -L "$candidate" ]]; then
    say 'Replacement source has no native manager; retaining the installed manager.'
    return
  fi
  [[ -f "$candidate" && ! -L "$candidate" ]] || die "Replacement manager must be a regular file in $source."
  bash -n "$candidate" || die 'Replacement manager has invalid Bash syntax; keeping the current installation.'
  help=$(bash "$candidate" --help) || die 'Replacement manager did not provide help successfully.'
  [[ "$help" == *'Usage: miaoyomi COMMAND'* && "$help" == *'set-solver'* && "$help" == *'update-suwayomi'* ]] || die 'Replacement source does not contain a compatible native Miaoyomi manager.'
  NEW_MANAGER=$NEW_RELEASE/.miaoyomi-manager
  install -m 755 "$candidate" "$NEW_MANAGER"
}

install_manager_file() {
  local source=$1 temporary=$MANAGER_PATH.new.$$ parent
  parent=$(dirname "$MANAGER_PATH")
  if [[ ! -d "$parent" ]]; then install -d -m 755 "$parent"; fi
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "Temporary manager already exists: $temporary"
  install -m 755 "$source" "$temporary"
  mv -f "$temporary" "$MANAGER_PATH"
}

install_staged_manager() {
  [[ -n "$NEW_MANAGER" ]] || return 0
  install_manager_file "$NEW_MANAGER"
}

run_as() { local user=$1; shift; su-exec "$user" "$@"; }

build_release() {
  local source=$1 component id
  validate_source "$source"
  id="$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4)"
  NEW_RELEASE=$RELEASES_DIR/$id
  mkdir -p "$RELEASES_DIR"
  mkdir "$NEW_RELEASE"
  say "Building release $id before stopping any services."
  # Copy only runtime projects. Never carry host credentials, local libraries,
  # old dependencies or old build output into a release.
  tar --exclude=node_modules --exclude=.next --exclude=out --exclude=dist --exclude=.env --exclude='.env.*' --exclude='*.tsbuildinfo' --exclude=state -C "$source" -cf - bff web novel-engine | tar -C "$NEW_RELEASE" -xf -
  chown -R miaoyomi-build:miaoyomi-build "$NEW_RELEASE"
  chmod 755 "$NEW_RELEASE"
  for component in bff web novel-engine; do
    (
      cd "$NEW_RELEASE/$component"
      run_as miaoyomi-build env HOME="$STATE_DIR/build" NODE_ENV=development PUPPETEER_SKIP_DOWNLOAD=true NEXT_TELEMETRY_DISABLED=1 npm ci --include=dev --no-audit --no-fund
      run_as miaoyomi-build env HOME="$STATE_DIR/build" NODE_ENV=production PUPPETEER_SKIP_DOWNLOAD=true NEXT_TELEMETRY_DISABLED=1 npm run build
      if [[ "$component" != web ]]; then run_as miaoyomi-build env HOME="$STATE_DIR/build" PUPPETEER_SKIP_DOWNLOAD=true npm prune --omit=dev --no-audit --no-fund; fi
    )
  done
  [[ -s "$NEW_RELEASE/bff/dist/server.js" && -s "$NEW_RELEASE/web/out/index.html" && -s "$NEW_RELEASE/novel-engine/dist/guest.js" ]] || die 'Build did not produce all required runtime files.'
  # Next is a build tool only. The BFF serves the export directly.
  rm -rf "$NEW_RELEASE/web/node_modules" "$NEW_RELEASE/web/.next"
  printf 'release=%s\ncreated=%s\nsource_repo=%s\nsource_ref=%s\n' "$id" "$(date -u +%FT%TZ)" "$SOURCE_REPO" "$SOURCE_REF" > "$NEW_RELEASE/.miaoyomi-release"
  chown -R root:root "$NEW_RELEASE"
  chmod -R go-w "$NEW_RELEASE"
  # Local source mode may have files copied from a 0700 root-owned source tree.
  chmod -R a+rX "$NEW_RELEASE"
}

obtain_source() {
  local supplied=$1 ref=$2
  if [[ -n "$supplied" ]]; then
    [[ -z "$ref" ]] || die '--ref cannot be combined with --source-dir.'
    SOURCE_TREE=$(cd "$supplied" && pwd -P)
    SOURCE_REPO='' SOURCE_REF=''
    return
  fi
  [[ -n "$SOURCE_REPO" ]] || die 'This installation uses local source. Supply update --source-dir /path/to/replacement-checkout.'
  if [[ -n "$ref" ]]; then SOURCE_REF=$ref; fi
  [[ -n "$SOURCE_REF" && "$SOURCE_REF" != -* && "$SOURCE_REF" != *$'\n'* && "$SOURCE_REF" != *$'\r'* ]] || die 'An explicit valid saved Git ref or --ref is required.'
  SOURCE_TREE=$(mktemp -d "$STATE_DIR/build/source.XXXXXXXX")
  chown miaoyomi-build:miaoyomi-build "$SOURCE_TREE"
  run_as miaoyomi-build git -C "$SOURCE_TREE" init -q
  run_as miaoyomi-build git -C "$SOURCE_TREE" remote add origin "$SOURCE_REPO"
  run_as miaoyomi-build env GIT_TERMINAL_PROMPT=0 git -C "$SOURCE_TREE" fetch --depth 1 origin "$SOURCE_REF"
  run_as miaoyomi-build git -C "$SOURCE_TREE" checkout --detach FETCH_HEAD
}

perform_backup() {
  local output=${1:-} member
  if [[ -z "$output" ]]; then output=$BACKUPS_DIR/$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 4); fi
  [[ "$output" == /* && "$output" != "$STATE_DIR" && "$output" != "$STATE_DIR/"* && "$output" != "$ETC_DIR/"* && "$output" != "$APP_DIR/"* ]] || die 'Backup output must be an absolute new directory outside configuration, state and releases.'
  [[ ! -e "$output" && ! -L "$output" ]] || die "Backup output already exists: $output"
  mkdir -p "$(dirname "$output")"
  mkdir -m 700 "$output"
  LAST_BACKUP=$output
  : > "$output/.incomplete"
  say "Backing up stopped writers to $output. External manga outside managed state is recorded, not copied."
  run_as postgres pg_dump --format=custom --no-owner --no-acl --dbname=miaoyomi > "$output/database.dump"
  [[ -s "$output/database.dump" ]] || die 'PostgreSQL produced an empty backup.'
  local members=("${ETC_DIR#/}" "${STATE_DIR#/}")
  if [[ -d "$PG_CONF_DIR" ]]; then members+=("${PG_CONF_DIR#/}"); fi
  if [[ -f "$MANAGER_PATH" && ! -L "$MANAGER_PATH" ]]; then members+=("${MANAGER_PATH#/}"); fi
  while IFS= read -r member; do
    if [[ -f "$INIT_DIR/$member" && ! -L "$INIT_DIR/$member" ]]; then members+=("${INIT_DIR#/}/$member"); fi
  done < <(writers)
  tar --exclude="${ETC_DIR#/}/operation.lock" --exclude="${STATE_DIR#/}/cache" --exclude="${STATE_DIR#/}/build" --exclude="${STATE_DIR#/}/backups" -czf "$output/files.tar.gz" -C / "${members[@]}"
  {
    printf 'format=miaoyomi-native-v1\ncreated=%s\npostgres_major=18\n' "$(date -u +%FT%TZ)"
    printf 'application_release=%s\nsuwayomi_jar=%s\nexternal_manga=%s\n' "$(readlink "$APP_DIR/current")" "$(readlink "$APP_DIR/suwayomi/current.jar")" "$MANGA_LIBRARY_PATH"
    printf 'external_flaresolverr=%s\nflaresolverr_ctid=%s\n' "$FLARESOLVERR_URL" "$FLARESOLVERR_CTID"
    printf 'The separate FlareSolverr LXC is not stopped, updated or included in this backup. Back it up through Proxmox.\n'
    printf 'Database is PostgreSQL custom format. files.tar.gz contains configuration and durable files relative to /.\n'
    printf 'Restore matching database, configuration and files together with the recorded application and engine versions.\n'
  } > "$output/manifest.txt"
  for member in database.dump files.tar.gz manifest.txt; do (cd "$output" && sha256sum "$member") >> "$output/SHA256SUMS"; done
  rm "$output/.incomplete"
}

select_release() {
  local selected=$1 link=$2 temporary
  temporary=$link.new.$$
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "Temporary symlink already exists: $temporary"
  ln -s "$selected" "$temporary"
  mv -Tf "$temporary" "$link"
}

update_native() {
  local supplied=$1 ref=$2
  require_installed
  require_recovered
  acquire_lock
  PHASE=build
  obtain_source "$supplied" "$ref"
  build_release "$SOURCE_TREE"
  stage_manager "$SOURCE_TREE"
  PREVIOUS_RELEASE=$(readlink "$APP_DIR/current")
  PHASE=before-cutover
  stop_writers
  perform_backup
  PHASE=cutover
  select_release "$NEW_RELEASE" "$APP_DIR/current"
  set_environment_key "$ETC_DIR/novel.env" FLARESOLVERR_URL "$FLARESOLVERR_URL"
  start_writers
  write_install_config
  install_staged_manager
  PHASE=idle
  say "Update complete. Previous release: $PREVIOUS_RELEASE; backup: $LAST_BACKUP"
}

download_suwayomi() {
  local version=$1 digest=$2 destination=$3
  [[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "$digest" =~ ^[a-fA-F0-9]{64}$ ]] || die 'Provide an explicit Suwayomi version vX.Y.Z and its SHA-256 digest.'
  [[ ! -e "$destination" ]] || die "Engine artifact already exists: $destination"
  curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "https://github.com/Suwayomi/Suwayomi-Server/releases/download/$version/Suwayomi-Server-$version.jar" --output "$destination"
  printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status
  chmod 644 "$destination"
}

update_suwayomi() {
  local version=$1 digest=$2 jar
  require_installed
  require_recovered
  [[ -n "$version" && -n "$digest" ]] || die 'update-suwayomi requires --version and --sha256.'
  acquire_lock
  jar=$APP_DIR/suwayomi/Suwayomi-Server-$version-$(openssl rand -hex 4).jar
  download_suwayomi "$version" "$digest" "$jar"
  PREVIOUS_RELEASE=$(readlink "$APP_DIR/current")
  NEW_RELEASE=$PREVIOUS_RELEASE
  PHASE=before-cutover
  stop_writers
  perform_backup
  PHASE=cutover
  select_release "$jar" "$APP_DIR/suwayomi/current.jar"
  start_writers
  write_suwayomi_env "$version" "$digest"
  PHASE=idle
  say "Suwayomi update complete. Backup: $LAST_BACKUP"
}

ensure_alpine_repositories() {
  local repo rest main='' community=no
  [[ -f "$APK_REPOSITORIES" ]] || die "Alpine repositories are unavailable: $APK_REPOSITORIES"
  while read -r repo rest || [[ -n "$repo" ]]; do
    case "$repo" in ''|\#*) continue;; esac
    [[ "$repo" =~ ^https?://[^[:space:]]+/v3\.24/(main|community)/?$ ]] || die "Only Alpine 3.24 main/community repositories are supported. Correct $APK_REPOSITORIES before installing packages."
    repo=${repo%/}
    case "$repo" in */main) main=$repo;; */community) community=yes;; esac
  done < "$APK_REPOSITORIES"
  [[ -n "$main" ]] || die "Enable an Alpine v3.24/main repository in $APK_REPOSITORIES."
  if [[ "$community" == no ]]; then
    say 'Enabling Alpine 3.24 community alongside the configured main mirror for npm and Java.'
    printf '\n%s/community\n' "${main%/main}" >> "$APK_REPOSITORIES"
  fi
}

install_packages() {
  ensure_alpine_repositories
  say 'Installing native Alpine packages; PostgreSQL major is pinned to 18.'
  apk add --no-cache bash ca-certificates coreutils curl git gzip openssl su-exec tar nodejs npm postgresql18 postgresql18-client postgresql18-openrc openjdk25-jre-headless
  [[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]] || die 'Alpine repositories did not supply Node 24; check the configured 3.24 repositories.'
  [[ $(pg_dump --version) == *' 18.'* ]] || die 'pg_dump must match PostgreSQL major 18.'
}

create_users_and_paths() {
  local user path
  for user in miaoyomi miaoyomi-novel miaoyomi-suwayomi miaoyomi-build; do
    if ! id "$user" >/dev/null 2>&1; then addgroup -S "$user"; adduser -S -D -H -h "$STATE_DIR/${user#miaoyomi-}" -s /sbin/nologin -G "$user" "$user"; fi
  done
  mkdir -p "$STATE_DIR" "$RELEASES_DIR" "$APP_DIR/suwayomi" "$BACKUPS_DIR" "$LOG_DIR"
  chmod 755 "$ETC_DIR" "$STATE_DIR" "$APP_DIR" "$RELEASES_DIR" "$APP_DIR/suwayomi"
  chmod 700 "$BACKUPS_DIR"
  chown root:root "$LOG_DIR"
  chmod 711 "$LOG_DIR"
  for path in config cache backups downloaded-manga novels; do mkdir -p "$STATE_DIR/$path"; chown miaoyomi:miaoyomi "$STATE_DIR/$path"; chmod 750 "$STATE_DIR/$path"; done
  for path in novel-engine suwayomi build; do
    mkdir -p "$STATE_DIR/$path"
    user=miaoyomi-$path
    [[ "$path" != novel-engine ]] || user=miaoyomi-novel
    chown "$user:$user" "$STATE_DIR/$path"
    chmod 700 "$STATE_DIR/$path"
  done
  if [[ -z "$MANGA_LIBRARY_PATH" ]]; then MANGA_LIBRARY_PATH=$STATE_DIR/manga; fi
  if [[ "$MANGA_LIBRARY_PATH" == "$STATE_DIR/manga" && ! -e "$MANGA_LIBRARY_PATH" && ! -L "$MANGA_LIBRARY_PATH" ]]; then
    mkdir "$MANGA_LIBRARY_PATH"
    chown miaoyomi:miaoyomi "$MANGA_LIBRARY_PATH"
    chmod 750 "$MANGA_LIBRARY_PATH"
  fi
  [[ -d "$MANGA_LIBRARY_PATH" ]] || die "Existing manga directory is unavailable: $MANGA_LIBRARY_PATH"
  if ! run_as miaoyomi test -r "$MANGA_LIBRARY_PATH" || ! run_as miaoyomi test -x "$MANGA_LIBRARY_PATH"; then
    die "The miaoyomi service user needs read/traverse access to $MANGA_LIBRARY_PATH. The installer never takes ownership of an existing collection."
  fi
}

write_env_line() { printf '%s=%q\n' "$1" "$2"; }

write_application_environment() {
  local password jwt token
  if [[ ! -f "$ETC_DIR/database.env" ]]; then
    write_env_line POSTGRES_PASSWORD "$(openssl rand -hex 32)" > "$ETC_DIR/database.env"
    chmod 600 "$ETC_DIR/database.env"
  fi
  require_root_file "$ETC_DIR/database.env"
  # shellcheck disable=SC1090,SC1091
  source "$ETC_DIR/database.env"
  password=$POSTGRES_PASSWORD
  [[ "$password" =~ ^[a-f0-9]{64}$ ]] || die 'The managed database password is invalid; restore database.env from your native backup.'
  if [[ -f "$ETC_DIR/app.env" || -f "$ETC_DIR/novel.env" ]]; then
    [[ -f "$ETC_DIR/app.env" && -f "$ETC_DIR/novel.env" ]] || die 'Incomplete environment files found. Restore both app.env and novel.env before retrying.'
    return
  fi
  jwt=$(openssl rand -hex 48)
  token=$(openssl rand -hex 48)
  {
    write_env_line NODE_ENV production
    write_env_line PORT "$WEB_PORT"
    write_env_line DATABASE_URL "postgresql://miaoyomi:$password@127.0.0.1:5432/miaoyomi"
    write_env_line JWT_SECRET "$jwt"
    write_env_line PUBLIC_ORIGIN "$PUBLIC_ORIGIN"
    write_env_line LIBRARY_BACKEND owned
    write_env_line LIBRARY_ROOT "$MANGA_LIBRARY_PATH"
    write_env_line DL_ROOT "$STATE_DIR/downloaded-manga"
    write_env_line NOVEL_LIBRARY_PATH "$STATE_DIR/novels"
    write_env_line CONFIG_DIR "$STATE_DIR/config"
    write_env_line CUSTOM_SITES_FILE "$STATE_DIR/config/sites.json"
    write_env_line CACHE_DIR "$STATE_DIR/cache"
    write_env_line BACKUP_DIR "$STATE_DIR/backups"
    write_env_line SOURCES_DIR "$STATE_DIR/config/sources"
    write_env_line WEB_ROOT "$APP_DIR/current/web/out"
    write_env_line NOVEL_ENGINE_URL http://127.0.0.1:4100
    write_env_line NOVEL_ENGINE_TOKEN "$token"
    write_env_line SUWAYOMI_URL http://127.0.0.1:4567
    write_env_line FLARESOLVERR_URL "$FLARESOLVERR_URL"
    write_env_line TZ UTC
  } > "$ETC_DIR/app.env"
  {
    write_env_line NODE_ENV production
    write_env_line HOST 127.0.0.1
    write_env_line PORT 4100
    write_env_line NOVEL_ENGINE_TOKEN "$token"
    write_env_line NOVEL_ENGINE_STATE_DIR "$STATE_DIR/novel-engine"
    write_env_line FLARESOLVERR_URL "$FLARESOLVERR_URL"
  } > "$ETC_DIR/novel.env"
  chown root:miaoyomi "$ETC_DIR/app.env"
  chown root:miaoyomi-novel "$ETC_DIR/novel.env"
  chmod 640 "$ETC_DIR/app.env" "$ETC_DIR/novel.env"
}

write_suwayomi_env() {
  local version=$1 digest=$2
  { write_env_line SUWAYOMI_VERSION "$version"; write_env_line SUWAYOMI_SHA256 "$digest"; } > "$ETC_DIR/suwayomi.env"
  chmod 600 "$ETC_DIR/suwayomi.env"
}

setup_database() {
  if [[ -f "$PG_DATA_DIR/PG_VERSION" ]]; then
    [[ -f "$ETC_DIR/database-managed" && $(cat "$PG_DATA_DIR/PG_VERSION") == 18 ]] || die 'An unmanaged or different-major PostgreSQL cluster exists; refusing to change it.'
  fi
  cat > /etc/conf.d/postgresql <<EOF
pg_version=18
data_dir="$PG_DATA_DIR"
conf_dir="$PG_CONF_DIR"
auto_setup=no
EOF
  if [[ ! -f "$PG_DATA_DIR/PG_VERSION" ]]; then
    : > "$ETC_DIR/database-managed"
    rc-service postgresql setup
  fi
  mkdir -p /var/log/postgresql
  chown postgres:postgres /var/log/postgresql
  cat > "$PG_CONF_DIR/miaoyomi.conf" <<'EOF'
listen_addresses = '127.0.0.1'
port = 5432
password_encryption = 'scram-sha-256'
logging_collector = on
log_directory = '/var/log/postgresql'
log_filename = 'postgresql.log'
EOF
  if ! grep -q "^include_if_exists = 'miaoyomi.conf'$" "$PG_CONF_DIR/postgresql.conf"; then printf "\ninclude_if_exists = 'miaoyomi.conf'\n" >> "$PG_CONF_DIR/postgresql.conf"; fi
  cat > "$PG_CONF_DIR/pg_hba.conf" <<'EOF'
local all postgres peer
local all all peer
host miaoyomi miaoyomi 127.0.0.1/32 scram-sha-256
host all all 127.0.0.1/32 reject
host all all ::1/128 reject
EOF
  chown postgres:postgres "$PG_CONF_DIR/miaoyomi.conf" "$PG_CONF_DIR/pg_hba.conf"
  chmod 640 "$PG_CONF_DIR/miaoyomi.conf" "$PG_CONF_DIR/pg_hba.conf"
  rc-update add postgresql default
  rc-service postgresql restart
  run_as postgres psql --set=ON_ERROR_STOP=1 --set=password="$POSTGRES_PASSWORD" --dbname=postgres <<'SQL'
SELECT format('CREATE ROLE miaoyomi LOGIN PASSWORD %L', :'password') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'miaoyomi') \gexec
SELECT 'CREATE DATABASE miaoyomi OWNER miaoyomi' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'miaoyomi') \gexec
SQL
}

write_service() {
  local service=$1 user=$2 directory=$3 command=$4 arguments=$5 environment=$6 dependencies=$7
  # supervise-daemon opens these after changing to command_user. Keep names
  # private while allowing each user to traverse to its own writable log.
  [[ ! -L "$LOG_DIR/$service.log" ]] || die "Refusing a symlink for $service log."
  touch "$LOG_DIR/$service.log"
  chown "$user:$user" "$LOG_DIR/$service.log"
  chmod 600 "$LOG_DIR/$service.log"
  cat > "$INIT_DIR/$service" <<EOF
#!/sbin/openrc-run
name="$service"
description="Miaoyomi native service"
supervisor=supervise-daemon
command="$command"
command_args='$arguments'
command_user="$user:$user"
directory="$directory"
pidfile="/run/$service.pid"
respawn_delay=5
respawn_max=0
retry="TERM/45/KILL/5"
output_log="$LOG_DIR/$service.log"
error_log="$LOG_DIR/$service.log"
export HOME="$STATE_DIR/${user#miaoyomi-}"
export TZ=UTC
EOF
  if [[ -n "$environment" ]]; then
    cat >> "$INIT_DIR/$service" <<EOF
set -a
. "$environment"
set +a
EOF
  fi
  if [[ "$service" == miaoyomi-suwayomi ]]; then
    # Insert JVM flags before -jar; options after it would be app arguments.
    cat >> "$INIT_DIR/$service" <<'EOF'
command_args="$SUWAYOMI_SOLVER_ARGS $command_args"
EOF
  fi
  cat >> "$INIT_DIR/$service" <<EOF
depend() {
  need net $dependencies
}
start_pre() {
  [ ! -f "$ETC_DIR/recovery-required" ] || { eerror "Resolve $ETC_DIR/recovery-required before starting writers"; return 1; }
  [ ! -L "$LOG_DIR/$service.log" ] || { eerror "Service log must not be a symlink"; return 1; }
  touch "$LOG_DIR/$service.log" || return 1
  chown "$user:$user" "$LOG_DIR/$service.log" || return 1
  chmod 600 "$LOG_DIR/$service.log" || return 1
}
EOF
  chmod 755 "$INIT_DIR/$service"
  rc-update add "$service" default
}

write_services() {
  write_service miaoyomi miaoyomi "$APP_DIR/current/bff" /usr/bin/node 'dist/server.js' "$ETC_DIR/app.env" postgresql
  write_service miaoyomi-novel miaoyomi-novel "$APP_DIR/current/novel-engine" /usr/bin/node 'src/server.mjs' "$ETC_DIR/novel.env" ''
  local arguments
  arguments="-Xms128m -Xmx1024m -Djava.awt.headless=true -Dsuwayomi.tachidesk.config.server.rootDir=$STATE_DIR/suwayomi -Dsuwayomi.tachidesk.config.server.ip=127.0.0.1 -Dsuwayomi.tachidesk.config.server.port=4567 -Dsuwayomi.tachidesk.config.server.initialOpenInBrowserEnabled=false -Dsuwayomi.tachidesk.config.server.systemTrayEnabled=false -Dsuwayomi.tachidesk.config.server.kcefEnabled=false -Dsuwayomi.tachidesk.config.server.autoDownloadNewChapters=false -Dsuwayomi.tachidesk.config.server.downloadAsCbz=true"
  arguments+=" -jar $APP_DIR/suwayomi/current.jar"
  write_solver_environment
  write_service miaoyomi-suwayomi miaoyomi-suwayomi "$STATE_DIR/suwayomi" /usr/bin/java "$arguments" "$ETC_DIR/suwayomi-solver.env" ''
}

start_install_log() {
  mkdir -p "$LOG_DIR"
  chown root:root "$LOG_DIR"
  chmod 711 "$LOG_DIR"
  [[ ! -L "$LOG_DIR/install.log" ]] || die 'The install log must not be a symlink.'
  touch "$LOG_DIR/install.log"
  chown root:root "$LOG_DIR/install.log"
  chmod 600 "$LOG_DIR/install.log"
  exec > >(tee -a "$LOG_DIR/install.log") 2>&1
}

install_native() {
  local source=$1 config=$2 jar
  [[ -n "$source" && -n "$config" ]] || die 'install requires --source-dir and --config.'
  [[ ! -f "$ETC_DIR/installed" ]] || die 'Already installed; use miaoyomi update.'
  validate_source "$source"
  load_install_config "$config"
  acquire_lock
  start_install_log
  install_packages
  create_users_and_paths
  write_application_environment
  write_install_config
  setup_database
  PHASE=build
  build_release "$source"
  jar=$APP_DIR/suwayomi/Suwayomi-Server-$SUWAYOMI_PIN.jar
  if [[ ! -e "$jar" ]]; then download_suwayomi "$SUWAYOMI_PIN" "$SUWAYOMI_DIGEST" "$jar"; else printf '%s  %s\n' "$SUWAYOMI_DIGEST" "$jar" | sha256sum --check --status; fi
  select_release "$jar" "$APP_DIR/suwayomi/current.jar"
  write_suwayomi_env "$SUWAYOMI_PIN" "$SUWAYOMI_DIGEST"
  write_services
  PHASE=cutover
  select_release "$NEW_RELEASE" "$APP_DIR/current"
  start_writers
  install_manager_file "${BASH_SOURCE[0]}"
  printf 'native-v1\n' > "$ETC_DIR/installed"
  PHASE=idle
  say "Installed. Forward your HTTPS reverse proxy to the guest on port $WEB_PORT, then open $PUBLIC_ORIGIN to create the first administrator."
}

main() {
  local command=${1:---help} source='' config='' ref='' version='' digest='' output='' log=app solver_url='' solver_ctid='' solver_url_set=no
  shift || true
  case "$command" in -h|--help|help) usage; return;; install|update|update-suwayomi|set-solver|backup|status|logs|restart) :;; *) die "Unknown command: $command";; esac
  while (($#)); do
    case "$command:$1" in
      install:--source-dir|update:--source-dir) (($# >= 2)) || die "$1 needs a value"; source=$2; shift 2;;
      install:--config) (($# >= 2)) || die "$1 needs a value"; config=$2; shift 2;;
      update:--ref) (($# >= 2)) || die "$1 needs a value"; ref=$2; shift 2;;
      update-suwayomi:--version) (($# >= 2)) || die "$1 needs a value"; version=$2; shift 2;;
      update-suwayomi:--sha256) (($# >= 2)) || die "$1 needs a value"; digest=$2; shift 2;;
      set-solver:--url) (($# >= 2)) || die "$1 needs a value"; solver_url=$2; solver_url_set=yes; shift 2;;
      set-solver:--ctid) (($# >= 2)) || die "$1 needs a value"; solver_ctid=$2; shift 2;;
      backup:--output) (($# >= 2)) || die "$1 needs a value"; output=$2; shift 2;;
      logs:app|logs:novel|logs:suwayomi|logs:postgres|logs:solver) log=$1; shift; (($# == 0)) || die 'logs takes one service name';;
      *) die "Unknown option for $command: $1";;
    esac
  done
  require_platform
  trap on_failure ERR
  trap 'on_failure 130' INT
  trap 'on_failure 143' TERM
  trap release_lock EXIT
  case "$command" in
    install) install_native "$source" "$config";;
    update) update_native "$source" "$ref";;
    update-suwayomi) update_suwayomi "$version" "$digest";;
    set-solver) [[ "$solver_url_set" == yes ]] || die "set-solver requires --url ORIGIN (or --url '' to disable)."; set_solver "$solver_url" "$solver_ctid";;
    backup) require_installed; acquire_lock; PHASE=backup; stop_writers; perform_backup "$output"; resume_previous_writers; PHASE=idle; say "Backup complete: $LAST_BACKUP";;
    restart) require_installed; require_recovered; acquire_lock; PHASE=before-cutover; stop_writers; PHASE=cutover; PREVIOUS_RELEASE=$(readlink "$APP_DIR/current"); NEW_RELEASE=$PREVIOUS_RELEASE; start_writers; PHASE=idle;;
    status)
      require_installed
      printf 'Release: %s\n' "$(readlink "$APP_DIR/current")"
      local service failed=0
      for service in postgresql $(writers); do rc-service "$service" status || failed=1; done
      solver_status || failed=1
      if [[ -f "$ETC_DIR/recovery-required" ]]; then cat "$ETC_DIR/recovery-required"; failed=1; fi
      return "$failed"
      ;;
    logs)
      require_installed
      case "$log" in
        app) log=$LOG_DIR/miaoyomi.log;; novel) log=$LOG_DIR/miaoyomi-novel.log;; suwayomi) log=$LOG_DIR/miaoyomi-suwayomi.log;; postgres) log=/var/log/postgresql/postgresql.log;;
        solver) die "FlareSolverr runs in a separate remote LXC${FLARESOLVERR_CTID:+ ($FLARESOLVERR_CTID)}. Read its logs there with journalctl -u flaresolverr -f.";;
      esac
      exec tail -n 100 -F "$log"
      ;;
  esac
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
