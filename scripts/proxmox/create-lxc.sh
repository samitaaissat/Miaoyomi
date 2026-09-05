#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
# Run on a Proxmox VE node. Standalone entry point; guest code comes from the source bundle.
# Inspired by the interactive host/guest split of community-scripts/ProxmoxVE.
set -Eeuo pipefail

ALPINE_VERSION=3.24
CTID=100
CT_HOSTNAME=miaoyomi
CORES=4
MEMORY=6144
DISK=32
STORAGE=local-lvm
TEMPLATE_STORAGE=local
BRIDGE=vmbr0
IP=dhcp
GATEWAY=
VLAN=
PUBLIC_ORIGIN=
WEB_PORT=8080
MANGA_MOUNT=
INSTALL_FLARESOLVERR=yes
FLARESOLVERR_CTID=
FLARESOLVERR_URL=
FLARESOLVERR_SCRIPT_URL=https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/flaresolverr.sh
NESTING=no
ACTION=create
CREATE_OPTIONS=()
# Used indirectly by write_guest_config.
# shellcheck disable=SC2034
MANGA_LIBRARY_PATH=/var/lib/miaoyomi/manga
SOURCE_DIR=
SOURCE_REPO=
SOURCE_REF=main
DRY_RUN=0
ASSUME_YES=0
CTID_SET=0
WORK_DIR=
CREATED=0
FINISHED=0
TEMPLATE=
SOLVER_ATTEMPTED=0

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }
usage() {
  cat <<'EOF'
Create an unprivileged Alpine LXC with the native Miaoyomi stack (run as root on Proxmox VE 8/9).

  bash scripts/proxmox/create-lxc.sh --source-dir /root/Miaoyomi
  bash create-lxc.sh --repo https://YOUR-DOWNSTREAM-REPOSITORY.git --ref main

Source (choose one):
  --source-dir PATH       Source checkout on the Proxmox node; includes uncommitted code
  --repo HTTPS_URL        Miaoyomi downstream Git URL (not the original Uchiyomi repository)
  --ref REF              Branch, tag or commit to install and save for updates [main]

Guest settings (the interactive wizard asks for these):
  --ctid ID              Unused cluster ID [next available]
  --hostname NAME        Guest hostname [miaoyomi]
  --cores N              vCPUs [4]
  --memory MIB           Memory, at least 4096 MiB [6144]
  --disk GIB             Root disk, at least 24 GiB [32]
  --storage NAME         Active storage supporting rootdir [local-lvm]
  --template-storage N   Active storage supporting vztmpl [local]
  --bridge NAME          Existing Linux bridge [vmbr0]
  --ip dhcp|IP/PREFIX    IPv4 configuration [dhcp]
  --gateway IP          Required with static IPv4; omit for DHCP
  --vlan ID             Optional VLAN, 1..4094
  --public-origin URL   Required HTTPS origin, e.g. https://read.example.com
  --web-port PORT        App port, 1024..65535 [8080]
  --manga-mount PATH     Existing host directory mounted read-only at /mnt/manga
  --flaresolverr yes|no  Run the official wizard for a separate Debian solver LXC [yes]
  --flaresolverr-ctid ID Reuse a native FlareSolverr LXC on this node instead
  --flaresolverr-url URL Use an existing reachable HTTP(S) solver origin instead
  --nesting yes|no       Enable the Alpine LXC nesting feature if needed [no]

Maintenance (no new LXC; specify an existing solver ID or URL):
  --reconnect APP_ID     Rediscover solver IP and update both application connections
  --update-solver APP_ID Run the paired solver's official updater, then reconnect

  --yes                 Use supplied settings/defaults and skip prompts/confirmation
  --dry-run             Validate inputs and print the creation command; make no changes
  --help                Show help

No Docker or other inner containers. Upstream solver LXC features are retained.
--yes requires --flaresolverr-ctid, --flaresolverr-url or --flaresolverr no;
the official new-solver wizard needs a terminal. Failed guests are kept for diagnosis.
The root account has no login password; use the Proxmox console or pct enter ID.
EOF
}

parse_args() {
  while (($#)); do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --yes) ASSUME_YES=1; shift; continue ;;
      --dry-run) DRY_RUN=1; ASSUME_YES=1; shift; continue ;;
      --source-dir|--repo|--ref|--ctid|--hostname|--cores|--memory|--disk|--storage|--template-storage|--bridge|--ip|--gateway|--vlan|--public-origin|--web-port|--manga-mount|--flaresolverr|--flaresolverr-ctid|--flaresolverr-url|--nesting|--reconnect|--update-solver)
        [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 requires a value" ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    case "$1" in
      --source-dir|--repo|--ref|--ctid|--hostname|--cores|--memory|--disk|--storage|--template-storage|--bridge|--ip|--gateway|--vlan|--public-origin|--web-port|--manga-mount|--nesting)
        CREATE_OPTIONS+=("$1") ;;
    esac
    case "$1" in
      --source-dir) SOURCE_DIR=$2 ;;
      --repo) SOURCE_REPO=$2 ;;
      --ref) SOURCE_REF=$2 ;;
      --ctid) CTID=$2; CTID_SET=1 ;;
      --hostname) CT_HOSTNAME=$2 ;;
      --cores) CORES=$2 ;;
      --memory) MEMORY=$2 ;;
      --disk) DISK=$2 ;;
      --storage) STORAGE=$2 ;;
      --template-storage) TEMPLATE_STORAGE=$2 ;;
      --bridge) BRIDGE=$2 ;;
      --ip) IP=$2 ;;
      --gateway) GATEWAY=$2 ;;
      --vlan) VLAN=$2 ;;
      --public-origin) PUBLIC_ORIGIN=$2 ;;
      --web-port) WEB_PORT=$2 ;;
      --manga-mount) MANGA_MOUNT=$2 ;;
      --flaresolverr) INSTALL_FLARESOLVERR=$2 ;;
      --flaresolverr-ctid) FLARESOLVERR_CTID=$2 ;;
      --flaresolverr-url) FLARESOLVERR_URL=$2 ;;
      --nesting) NESTING=$2 ;;
      --reconnect|--update-solver)
        [[ $ACTION == create ]] || die 'Choose only one maintenance action'
        ACTION=${1#--}; CTID=$2; CTID_SET=1 ;;
    esac
    shift 2
  done
}

integer_range() {
  if ! [[ $2 =~ ^[1-9][0-9]*$ && ${#2} -le 9 ]]; then die "$1 must be between $3 and $4"; fi
  (( $2 >= $3 && $2 <= $4 )) || die "$1 must be between $3 and $4"
}
valid_ipv4() {
  local part
  local -a parts
  [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a parts <<< "$1"
  for part in "${parts[@]}"; do
    [[ ${#part} -le 3 ]] && ((10#$part <= 255)) || return 1
    [[ "$part" == 0 || "$part" != 0* ]] || return 1
  done
}
validate_source_tree() {
  local path
  [[ -d $1 ]] || die "Source directory does not exist: $1"
  for path in bff/package.json bff/package-lock.json web/package.json web/package-lock.json novel-engine/package.json novel-engine/package-lock.json scripts/proxmox/miaoyomi-native.sh; do
    [[ -f "$1/$path" ]] || die "Source is missing $path; use this Miaoyomi downstream checkout"
  done
}
validate_solver_settings() {
  case "$INSTALL_FLARESOLVERR" in
    yes|no) ;;
    *) die "--flaresolverr must be yes or no" ;;
  esac
  [[ -z $FLARESOLVERR_CTID || -z $FLARESOLVERR_URL ]] || die 'Choose a FlareSolverr CT ID or URL, not both'
  if [[ $INSTALL_FLARESOLVERR == no ]]; then
    [[ -z $FLARESOLVERR_CTID && -z $FLARESOLVERR_URL ]] || die 'FlareSolverr is disabled but a connection was supplied'
  fi
  if [[ -n $FLARESOLVERR_CTID ]]; then
    integer_range 'FlareSolverr CTID' "$FLARESOLVERR_CTID" 100 999999999
    [[ $FLARESOLVERR_CTID != "$CTID" ]] || die 'FlareSolverr must be in a separate LXC'
  fi
  if [[ -n $FLARESOLVERR_URL ]]; then
    local host label port labels=()
    FLARESOLVERR_URL=${FLARESOLVERR_URL%/}
    [[ $FLARESOLVERR_URL =~ ^https?://([a-zA-Z0-9.-]+)(:([0-9]+))?$ ]] || die 'FlareSolverr URL must be an HTTP(S) origin without credentials or a path'
    host=${BASH_REMATCH[1]}; port=${BASH_REMATCH[3]:-}
    [[ ${#host} -le 253 && $host != *..* && $host != *. ]] || die 'Invalid FlareSolverr hostname'
    IFS=. read -r -a labels <<< "$host"
    for label in "${labels[@]}"; do
      [[ $label =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ && ${#label} -le 63 ]] || die 'Invalid FlareSolverr hostname'
    done
    [[ -z $port ]] || integer_range 'FlareSolverr port' "$port" 1 65535
  fi
  if [[ $ACTION != create ]]; then
    [[ -n $FLARESOLVERR_CTID || -n $FLARESOLVERR_URL ]] || die 'Maintenance requires --flaresolverr-ctid or --flaresolverr-url'
    [[ $ACTION != update-solver || -n $FLARESOLVERR_CTID ]] || die '--update-solver requires a local --flaresolverr-ctid'
  elif [[ $DRY_RUN == 0 && $ASSUME_YES == 1 && $INSTALL_FLARESOLVERR == yes && -z $FLARESOLVERR_CTID && -z $FLARESOLVERR_URL ]]; then
    die 'The official FlareSolverr wizard needs a terminal. Omit --yes, reuse --flaresolverr-ctid/--flaresolverr-url, or select --flaresolverr no'
  fi
}
validate_settings() {
  if [[ $ACTION != create && ${#CREATE_OPTIONS[@]} -gt 0 ]]; then
    die "Creation options cannot be combined with --$ACTION: ${CREATE_OPTIONS[*]}"
  fi
  integer_range CTID "$CTID" 100 999999999
  validate_solver_settings
  [[ $ACTION == create ]] || return 0
  [[ $NESTING == yes || $NESTING == no ]] || die '--nesting must be yes or no'
  integer_range Cores "$CORES" 1 128
  integer_range Memory "$MEMORY" 4096 1048576
  integer_range Disk "$DISK" 24 1048576
  integer_range 'Web port' "$WEB_PORT" 1024 65535
  case "$WEB_PORT" in 4100|4567|5432) die "Web port conflicts with an internal service" ;; esac
  [[ $CT_HOSTNAME =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$ && ${#CT_HOSTNAME} -le 63 ]] || die "Invalid guest hostname"
  local name
  for name in "$STORAGE" "$TEMPLATE_STORAGE"; do
    [[ $name =~ ^[a-zA-Z][a-zA-Z0-9_-]*$ ]] || die "Invalid storage name: $name"
  done
  [[ $BRIDGE =~ ^[a-zA-Z][a-zA-Z0-9_.-]*$ && ${#BRIDGE} -le 15 ]] || die "Invalid bridge name"
  [[ -z $VLAN ]] || integer_range VLAN "$VLAN" 1 4094
  if [[ $IP == dhcp ]]; then
    [[ -z $GATEWAY ]] || die "Do not set --gateway with DHCP"
  else
    [[ $IP =~ ^([0-9.]+)/([0-9]+)$ ]] || die "Static IPv4 must use IP/prefix notation"
    local address=${BASH_REMATCH[1]} prefix=${BASH_REMATCH[2]}
    valid_ipv4 "$address" || die "Invalid static IPv4 address"
    integer_range 'IPv4 prefix' "$prefix" 1 32
    valid_ipv4 "$GATEWAY" || die "Static IPv4 requires a valid --gateway"
  fi
  PUBLIC_ORIGIN=${PUBLIC_ORIGIN%/}
  [[ $PUBLIC_ORIGIN =~ ^https://([a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?)(:([0-9]+))?$ ]] || die "--public-origin must be an HTTPS origin without credentials, path, query or fragment"
  [[ -z ${BASH_REMATCH[4]} ]] || integer_range 'HTTPS port' "${BASH_REMATCH[4]}" 1 65535
  [[ -z $SOURCE_DIR || -z $SOURCE_REPO ]] || die "Choose --source-dir or --repo, not both"
  [[ -n $SOURCE_DIR || -n $SOURCE_REPO ]] || die "Provide --source-dir or an HTTPS --repo for this downstream"
  if [[ -n $SOURCE_REPO ]]; then
    [[ $SOURCE_REPO =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/[a-zA-Z0-9._/-]+$ ]] || die "Repository must be an HTTPS Git URL without embedded credentials"
  fi
  [[ $SOURCE_REF =~ ^[a-zA-Z0-9][a-zA-Z0-9._/-]*$ ]] || die "Invalid Git ref"
  if [[ -n $SOURCE_DIR ]]; then validate_source_tree "$SOURCE_DIR"; fi
  if [[ -n $MANGA_MOUNT ]]; then
    [[ $MANGA_MOUNT == /* && $MANGA_MOUNT != / && $MANGA_MOUNT != *[,[:space:]]* && -d $MANGA_MOUNT && ! -L $MANGA_MOUNT ]] || die "Manga bind mount must be an existing absolute directory without whitespace/commas or a symlink"
    # shellcheck disable=SC2034
    MANGA_LIBRARY_PATH=/mnt/manga
  fi
}

require_host() {
  [[ $EUID == 0 ]] || die "Run this installer as root on the Proxmox node"
  [[ $(uname -m) == x86_64 ]] || die "This installer supports x86_64 Proxmox nodes"
  local command version
  for command in pct pveam pvesm pvesh pveversion ip tar gzip flock curl; do
    command -v "$command" >/dev/null || die "Missing $command; run on a Proxmox VE node"
  done
  version=$(pveversion)
  [[ $version =~ pve-manager/(8|9)\. ]] || die "Supported Proxmox VE versions are 8 and 9; found $version"
}
acquire_host_lock() {
  exec 9>/run/lock/miaoyomi-create.lock
  flock -n 9 || die 'Another Miaoyomi host operation is running on this node'
}
ensure_unused_id() {
  pvesh get /cluster/nextid --vmid "$CTID" >/dev/null 2>&1 || die "Container/VM ID $CTID is already in use or the cluster cannot confirm it is available"
}
check_storage() {
  local result
  result=$(pvesm status --storage "$1" --content "$2")
  awk -v name="$1" '$1 == name && $3 == "active" { found=1 } END { exit !found }' <<< "$result" || die "Storage $1 must be active and support $2 on this node"
}
check_host_settings() {
  ensure_unused_id
  check_storage "$STORAGE" rootdir
  check_storage "$TEMPLATE_STORAGE" vztmpl
  ip link show dev "$BRIDGE" >/dev/null 2>&1 || die "Bridge $BRIDGE does not exist"
  [[ -d /sys/class/net/$BRIDGE/bridge ]] || die "$BRIDGE is not a Linux bridge"
}

prompt() {
  local variable=$1 label=$2 value current
  current=${!variable}
  printf '%s [%s]: ' "$label" "${current:-none}" >&3
  IFS= read -r value <&3 || die "Input closed; no container was created"
  if [[ $value == - ]]; then
    printf -v "$variable" '%s' ''
  elif [[ -n $value ]]; then
    printf -v "$variable" '%s' "$value"
  fi
}
wizard() {
  exec 3<>/dev/tty || die "Interactive install needs a terminal; use --yes with --public-origin"
  printf '\nMiaoyomi — native Alpine LXC\nPress Enter for defaults; enter - to clear an optional value.\n' >&3
  if [[ -z $SOURCE_DIR && -z $SOURCE_REPO ]]; then prompt SOURCE_REPO 'Downstream HTTPS Git URL'; fi
  if [[ -n $SOURCE_REPO ]]; then prompt SOURCE_REF 'Git branch, tag or commit'; fi
  prompt CTID 'Container ID'
  prompt CT_HOSTNAME 'Hostname'
  prompt INSTALL_FLARESOLVERR 'Use a separate FlareSolverr browser solver (yes/no)'
  if [[ $INSTALL_FLARESOLVERR == yes ]]; then
    prompt FLARESOLVERR_CTID 'Existing local FlareSolverr CT ID (empty launches the official creation wizard)'
    if [[ -z $FLARESOLVERR_CTID ]]; then prompt FLARESOLVERR_URL 'Existing external solver URL (optional; empty creates a new LXC)'; fi
  fi
  prompt CORES 'CPU cores'
  prompt MEMORY 'Memory (MiB)'
  prompt DISK 'Root disk (GiB; allow extra space for books, builds and update backups)'
  pvesm status >&3
  prompt STORAGE 'Root disk storage'
  prompt TEMPLATE_STORAGE 'Template storage'
  prompt BRIDGE 'Network bridge'
  prompt IP 'IPv4 (dhcp or address/prefix)'
  if [[ $IP != dhcp ]]; then prompt GATEWAY 'IPv4 gateway'; else GATEWAY=; fi
  prompt VLAN 'VLAN (optional)'
  prompt PUBLIC_ORIGIN 'Public HTTPS origin'
  prompt WEB_PORT 'App port'
  prompt MANGA_MOUNT 'Existing host manga directory (optional; read-only bind mount)'
  prompt NESTING 'Enable Alpine LXC nesting feature (yes/no; no inner containers are installed)'
}

create_args() {
  local net="name=eth0,bridge=$BRIDGE,ip=$IP,ip6=manual,firewall=1"
  [[ -z $GATEWAY ]] || net+=",gw=$GATEWAY"
  [[ -z $VLAN ]] || net+=",tag=$VLAN"
  CREATE_ARGS=(create "$CTID" "$TEMPLATE" --hostname "$CT_HOSTNAME" --ostype alpine --arch amd64
    --cores "$CORES" --memory "$MEMORY" --swap 512 --rootfs "$STORAGE:$DISK"
    --net0 "$net" --unprivileged 1 --onboot 1 --start 0 --timezone host
    --tags 'miaoyomi;native' --description 'Miaoyomi native Alpine installation. Manage: pct exec CTID -- miaoyomi status')
  if [[ -n $MANGA_MOUNT ]]; then CREATE_ARGS+=(--mp0 "$MANGA_MOUNT,mp=/mnt/manga,ro=1"); fi
  if [[ $NESTING == yes ]]; then CREATE_ARGS+=(--features nesting=1); fi
}
summary() {
  printf '\nContainer: %s (%s), Alpine %s, unprivileged\n' "$CTID" "$CT_HOSTNAME" "$ALPINE_VERSION"
  printf 'Resources: %s cores, %s MiB RAM, %s GiB root disk on %s\n' "$CORES" "$MEMORY" "$DISK" "$STORAGE"
  printf 'Network: %s, %s, gateway=%s, VLAN=%s\n' "$BRIDGE" "$IP" "${GATEWAY:-automatic}" "${VLAN:-none}"
  printf 'App: port %s → %s\n' "$WEB_PORT" "$PUBLIC_ORIGIN"
  if [[ $INSTALL_FLARESOLVERR == no ]]; then
    printf 'FlareSolverr: disabled\n'
  elif [[ -n $FLARESOLVERR_CTID || -n $FLARESOLVERR_URL ]]; then
    printf 'FlareSolverr: existing %s\n' "${FLARESOLVERR_URL:-LXC $FLARESOLVERR_CTID}"
  else
    printf 'FlareSolverr: official community wizard creates a separate Debian LXC (own resources/network)\n'
  fi
  printf 'Source: %s (ref %s)\n' "${SOURCE_DIR:-$SOURCE_REPO}" "$SOURCE_REF"
  printf 'Existing manga: %s\n' "${MANGA_MOUNT:-none}"
}
confirm() {
  local answer
  printf '\nProceed with this installation? [y/N]: ' >&3
  IFS= read -r answer <&3 || die "Input closed; cancelled"
  [[ $answer == y || $answer == Y || $answer == yes ]] || die "Cancelled; no container was created"
}

pack_source() {
  local source=$1 destination=$2
  validate_source_tree "$source"
  # An allowlist excludes top-level personal material; recursive exclusions cover build-local secrets.
  local -a entries=(bff web novel-engine scripts)
  [[ ! -f $source/LICENSE ]] || entries+=(LICENSE)
  COPYFILE_DISABLE=1 tar -czf "$destination" \
    --exclude=.git --exclude=.env --exclude='.env.*' --exclude=node_modules \
    --exclude=.next --exclude=out --exclude=dist --exclude=data --exclude=.cache --exclude=.npmrc \
    --exclude=.npm --exclude=coverage --exclude=.DS_Store --exclude='._*' \
    -C "$source" "${entries[@]}"
}
prepare_source() {
  if [[ -n $SOURCE_REPO ]]; then
    if ! command -v git >/dev/null; then
      log 'Installing Git for source download'
      apt-get update
      apt-get install -y --no-install-recommends git ca-certificates
    fi
    log 'Fetching the selected downstream source'
    GIT_TERMINAL_PROMPT=0 git clone --no-checkout --depth=1 -- "$SOURCE_REPO" "$WORK_DIR/source"
    GIT_TERMINAL_PROMPT=0 git -C "$WORK_DIR/source" fetch --depth=1 origin "$SOURCE_REF"
    git -C "$WORK_DIR/source" checkout --detach FETCH_HEAD
    SOURCE_DIR=$WORK_DIR/source
  fi
  pack_source "$SOURCE_DIR" "$WORK_DIR/source.tar.gz"
}
write_guest_config() {
  local key
  (umask 077; for key in PUBLIC_ORIGIN WEB_PORT SOURCE_REPO SOURCE_REF MANGA_LIBRARY_PATH FLARESOLVERR_URL FLARESOLVERR_CTID; do
    printf '%s=%q\n' "$key" "${!key}"
  done > "$1")
}
prepare_template() {
  log "Finding the Alpine $ALPINE_VERSION amd64 template"
  pveam update
  local name
  name=$(pveam available --section system | awk -v version="$ALPINE_VERSION" '$2 ~ ("^alpine-" version "-.*amd64\\.tar\\.") { print $2 }' | sort -V | tail -n 1)
  [[ -n $name ]] || die "No Alpine $ALPINE_VERSION amd64 template available; update Proxmox/template catalog and retry"
  TEMPLATE="$TEMPLATE_STORAGE:vztmpl/$name"
  if ! pveam list "$TEMPLATE_STORAGE" | awk -v template="$TEMPLATE" '$1 == template { found=1 } END { exit !found }'; then
    pveam download "$TEMPLATE_STORAGE" "$name"
  fi
}
create_container() {
  create_args
  pct "${CREATE_ARGS[@]}"
  CREATED=1
  pct start "$CTID"
}
guest_address() {
  pct exec "${1:-$CTID}" -- ip -4 -o addr show dev eth0 scope global | awk '{ split($4,a,"/"); print a[1]; exit }'
}

check_solver_container() {
  local id=$1
  [[ $id != "$CTID" ]] || die 'FlareSolverr must run in a separate LXC'
  pct status "$id" | grep -q '^status: running$' || die "FlareSolverr LXC $id must exist and be running on this node"
  pct exec "$id" -- test -f /etc/systemd/system/flaresolverr.service || die "LXC $id has no native community FlareSolverr service"
}

download_community_script() {
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    --connect-timeout 15 --max-time 120 --retry 3 "$FLARESOLVERR_SCRIPT_URL" --output "$1"
  [[ -s $1 ]] || die 'The official FlareSolverr installer download is empty'
  bash -n "$1"
}

run_community_script() {
  # Keep the official wizard on the terminal in its own Bash process. Do not
  # source it: its exit statements, variables and traps belong to that process.
  # Never pass the app's static IP; the solver requires a different address.
  var_post_install="$WORK_DIR/record-solver.sh" var_brg="$BRIDGE" \
    bash "$WORK_DIR/flaresolverr.sh" 9>&-
}

create_solver_container() {
  local before id receipt=$WORK_DIR/solver.ctid
  before=$(pct list | awk 'NR > 1 {print $1}')
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    # The hook expands these variables later in the upstream child process.
    # shellcheck disable=SC2016
    printf '[[ ${APP:-} == FlareSolverr && ${CTID:-} =~ ^[1-9][0-9]*$ ]] || exit 1\n'
    # shellcheck disable=SC2016
    printf 'umask 077\nprintf "%%s\\n" "$CTID" > %q\n' "$receipt"
  } > "$WORK_DIR/record-solver.sh"
  chmod 700 "$WORK_DIR/record-solver.sh"
  download_community_script "$WORK_DIR/flaresolverr.sh"
  SOLVER_ATTEMPTED=1
  log 'Opening the official FlareSolverr wizard for a separate LXC'
  printf 'Use an address reachable from Miaoyomi. Retain the prefilled post-install hook so this installer can identify the new LXC.\n'
  run_community_script || die 'The official FlareSolverr installer failed/cancelled. Any guests it created are kept; inspect pct list before retrying.'
  [[ -f $receipt && ! -L $receipt ]] || die 'The official wizard did not report its new LXC. Inspect pct list and reuse it with --flaresolverr-ctid; no container was guessed.'
  id=$(cat "$receipt")
  integer_range 'FlareSolverr receipt CTID' "$id" 100 999999999
  if grep -qxF "$id" <<< "$before"; then die "FlareSolverr receipt points to pre-existing LXC $id; refusing to connect automatically"; fi
  check_solver_container "$id"
  FLARESOLVERR_CTID=$id
  log "Official FlareSolverr LXC $id identified"
}

resolve_solver_address() {
  local address attempt
  check_solver_container "$FLARESOLVERR_CTID"
  for attempt in {1..30}; do
    address=$(guest_address "$FLARESOLVERR_CTID")
    if valid_ipv4 "$address"; then FLARESOLVERR_URL="http://$address:8191"; return; fi
    sleep 2
  done
  die "No usable IPv4 address on FlareSolverr LXC $FLARESOLVERR_CTID eth0"
}

prepare_solver() {
  [[ $INSTALL_FLARESOLVERR == yes ]] || return 0
  if [[ -z $FLARESOLVERR_CTID && -z $FLARESOLVERR_URL ]]; then create_solver_container; fi
  if [[ -n $FLARESOLVERR_CTID ]]; then resolve_solver_address; fi
}

verify_solver_connection() {
  [[ -n $FLARESOLVERR_URL ]] || return 0
  log "Checking FlareSolverr from Miaoyomi LXC $CTID at $FLARESOLVERR_URL"
  # The root endpoint identifies the service and is served after browser startup.
  # Run this in the app guest: a host-only probe cannot prove guest routing/firewall access.
  pct exec "$CTID" -- node -e '
    const endpoint = process.argv[1];
    async function check() {
      for (let i = 0; i < 30; i++) {
        try {
          const response = await fetch(endpoint + "/", {signal: AbortSignal.timeout(5000), redirect: "error"});
          const body = await response.json();
          if (response.ok && body.msg === "FlareSolverr is ready!" && typeof body.version === "string" && body.version) return;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      throw new Error("FlareSolverr unreachable or not ready; check both LXC networks and TCP 8191 firewall access");
    }
    check().catch(error => { console.error(error.message); process.exitCode = 1; });
  ' "$FLARESOLVERR_URL"
}

maintain_solver() {
  pct exec "$CTID" -- test -f /etc/miaoyomi/installed || die "LXC $CTID has no completed native Miaoyomi installation"
  if [[ -n $FLARESOLVERR_CTID ]]; then
    check_solver_container "$FLARESOLVERR_CTID"
    if [[ $ACTION == update-solver ]]; then
      pct exec "$FLARESOLVERR_CTID" -- test -f /usr/bin/update || die 'The FlareSolverr community updater is missing'
      log "Running the official updater in FlareSolverr LXC $FLARESOLVERR_CTID"
      pct exec "$FLARESOLVERR_CTID" -- env PHS_SILENT=1 bash /usr/bin/update
    fi
    resolve_solver_address
  fi
  verify_solver_connection
  pct exec "$CTID" -- miaoyomi set-solver --url "$FLARESOLVERR_URL" --ctid "$FLARESOLVERR_CTID"
  printf 'FlareSolverr connection verified and saved for Miaoyomi LXC %s: %s\n' "$CTID" "$FLARESOLVERR_URL"
}
install_guest() {
  local attempt ready=0
  log 'Waiting for guest networking and Alpine package repositories'
  for attempt in {1..30}; do
    if pct exec "$CTID" -- sh -ec 'ip -4 addr show dev eth0 | grep -q "inet "; apk update' >/dev/null 2>&1; then ready=1; break; fi
    printf 'Waiting for guest network (%s/30)...\n' "$attempt"
    sleep 2
  done
  [[ $ready == 1 ]] || die "Guest has no working IPv4/DNS/package access; inspect pct enter $CTID"
  pct exec "$CTID" -- apk add --no-cache bash ca-certificates tar nodejs
  verify_solver_connection
  write_guest_config "$WORK_DIR/install.conf"
  pct push "$CTID" "$WORK_DIR/source.tar.gz" /root/miaoyomi-source.tar.gz --perms 600
  pct push "$CTID" "$WORK_DIR/install.conf" /root/miaoyomi-install.conf --perms 600
  pct exec "$CTID" -- sh -ec 'mkdir -p /root/miaoyomi-source; tar -xzf /root/miaoyomi-source.tar.gz -C /root/miaoyomi-source'
  log 'Installing and building native services (this can take several minutes)'
  pct exec "$CTID" -- bash /root/miaoyomi-source/scripts/proxmox/miaoyomi-native.sh install \
    --source-dir /root/miaoyomi-source --config /root/miaoyomi-install.conf
  pct exec "$CTID" -- rm -f /root/miaoyomi-source.tar.gz /root/miaoyomi-install.conf
}
cleanup() {
  local code=$?
  trap - EXIT
  [[ -z $WORK_DIR ]] || rm -rf -- "$WORK_DIR"
  if [[ $FINISHED == 0 && $CREATED == 1 ]]; then
    printf '\nInstallation did not finish. Container %s was kept. Inspect: pct enter %s\n' "$CTID" "$CTID" >&2
    printf 'Guest installer log (if started): /var/log/miaoyomi/install.log\n' >&2
  elif [[ $FINISHED == 0 && $code != 0 ]]; then
    printf '\nInstallation stopped. No existing container was changed. Check pct list if creation failed partway.\n' >&2
  fi
  if [[ $FINISHED == 0 && $SOLVER_ATTEMPTED == 1 ]]; then
    printf 'The official solver wizard was started. Any solver LXC is also kept; inspect pct list.\n' >&2
  fi
  exit "$code"
}
main() {
  parse_args "$@"
  if [[ $ACTION != create ]]; then
    validate_settings
    if [[ $DRY_RUN == 1 ]]; then
      printf 'Dry run: %s for Miaoyomi LXC %s using solver %s. No containers will be created.\n' "$ACTION" "$CTID" "${FLARESOLVERR_URL:-LXC $FLARESOLVERR_CTID}"
      return
    fi
    require_host
    acquire_host_lock
    maintain_solver
    return
  fi
  if [[ -z $SOURCE_DIR && -z $SOURCE_REPO && -n ${BASH_SOURCE[0]:-} && -f ${BASH_SOURCE[0]:-} ]]; then
    local candidate
    candidate=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
    if [[ -f $candidate/novel-engine/package.json ]]; then SOURCE_DIR=$candidate; fi
  fi
  if [[ -z $SOURCE_DIR && -z $SOURCE_REPO ]]; then SOURCE_REPO=https://github.com/samitaaissat/Miaoyomi.git; fi
  if [[ $DRY_RUN == 0 ]]; then
    require_host
    [[ $CTID_SET == 1 ]] || CTID=$(pvesh get /cluster/nextid)
    if [[ $ASSUME_YES == 0 ]]; then wizard; fi
  fi
  validate_settings
  summary
  if [[ $DRY_RUN == 1 ]]; then
    TEMPLATE="$TEMPLATE_STORAGE:vztmpl/alpine-$ALPINE_VERSION-<catalog-version>_amd64.tar.xz"
    create_args
    printf '\nDry run (host availability and remote source not checked):\npct '
    printf '%q ' "${CREATE_ARGS[@]}"
    printf '\nThen start the guest, transfer source and install native services.\n'
    return
  fi
  check_host_settings
  if [[ -n $FLARESOLVERR_CTID ]]; then check_solver_container "$FLARESOLVERR_CTID"; fi
  if [[ $ASSUME_YES == 0 ]]; then confirm; fi
  acquire_host_lock
  umask 077
  WORK_DIR=$(mktemp -d /var/tmp/miaoyomi-install.XXXXXX)
  trap cleanup EXIT
  prepare_source
  prepare_template
  ensure_unused_id
  log "Creating container $CTID"
  create_container
  prepare_solver
  install_guest
  local address
  address=$(guest_address)
  [[ -n $address ]] || die 'Installation completed but the guest has no IPv4 address'
  FINISHED=1
  printf '\nMiaoyomi is ready in LXC %s.\n' "$CTID"
  printf 'Proxy target: http://%s:%s\nOpen: %s (create the first administrator)\n' "$address" "$WEB_PORT" "$PUBLIC_ORIGIN"
  printf 'Status: pct exec %s -- miaoyomi status\nUpdate: pct exec %s -- miaoyomi update\n' "$CTID" "$CTID"
  if [[ -n $FLARESOLVERR_CTID ]]; then
    printf 'FlareSolverr: LXC %s at %s (official updater: pct exec %s -- bash /usr/bin/update)\n' "$FLARESOLVERR_CTID" "$FLARESOLVERR_URL" "$FLARESOLVERR_CTID"
    printf 'After an IP change, rerun this host script with --reconnect %s --flaresolverr-ctid %s. Use stable DHCP reservations or static IPs.\n' "$CTID" "$FLARESOLVERR_CTID"
  fi
  if [[ -z $SOURCE_REPO ]]; then
    printf 'Local-source install: updates need --source-dir pointing to a new checkout inside the guest.\n'
  fi
  printf 'Restrict the app port to your trusted reverse proxy/LAN. No SSH password was configured.\n'
}

if [[ ${BASH_SOURCE[0]:-$0} == "$0" ]]; then main "$@"; fi
