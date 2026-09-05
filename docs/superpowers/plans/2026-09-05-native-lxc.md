# Native LXC Installation Implementation Plan

> **For agentic workers:** Use the native LXC design and the task ownership below. Preserve existing uncommitted work; do not commit or publish this checkout.

**Goal:** Install the full Miaoyomi stack natively from one Proxmox-node command, with interactive configuration, an Alpine app LXC, a separate official Debian FlareSolverr LXC and repeatable maintenance.

**Architecture:** A standalone host wizard handles app provisioning/source transfer, runs the official community solver wizard, identifies the resulting separate guest and connects both manga clients to it. An Alpine guest manager builds releases, writes OpenRC services and owns app maintenance and solver connection configuration. The upstream Debian `/usr/bin/update` owns solver updates. Native operations documentation replaces the Docker-based LXC recommendation.

**Tech Stack:** Bash, Alpine 3.24, OpenRC, Node 24, PostgreSQL 18, OpenJDK 25, Suwayomi 2.3.2243; separate Debian/Chrome/FlareSolverr/systemd installed by community-scripts.

**Spec:** `docs/superpowers/specs/2026-09-05-native-lxc-design.md`

## Global Constraints

- No Docker, Podman or other inner containers; unprivileged amd64 app guest. The Proxmox nesting feature is allowed when needed: expose app `--nesting yes|no`, default `no`, and retain upstream solver feature settings.
- Never overwrite existing container IDs, existing source trees or existing user collections.
- Use the configured `samitaaissat/Miaoyomi` remote only after these changes are published at the selected ref; local source installation remains available.
- Keep persistent state outside versioned release directories.
- Fail before creation on invalid input; keep the created app guest on failure. The official solver wizard owns its failure handling; never delete/reconfigure unrelated existing guests.
- Back up before migrations; no automatic code-only rollback after migrations.
- Preserve all existing user changes and existing Compose functionality.

## Task 1: Proxmox wizard (root agent)

- [x] Write executable Node test harness for CLI validation, existing-ID refusal, safe source packaging and Proxmox command generation; establish failing baseline.
- [x] Complete `scripts/proxmox/create-lxc.sh` with interactive prompts and `--yes`/explicit options for unattended use, dry-run, local/Git source modes, template selection, network/resource/storage checks and guest transfer. App resources remain 4 cores/6144 MiB/32 GiB regardless of solver choice.
- [x] Default `--flaresolverr yes` to the official interactive Debian LXC wizard. Support `--flaresolverr no`, reuse via `--flaresolverr-ctid ID`, or an external `--flaresolverr-url URL`. Reject `--yes` with a new solver, while allowing unattended app creation with an existing endpoint or solver disabled.
- [x] Identify the actual new solver through supported receipt/discovery data, exclude pre-existing IDs, verify native service identity and refuse ambiguous matches. Discover its address and check it from the app guest. Preserve upstream solver features and provide app `--nesting yes|no` separately.
- [x] Implement host `--reconnect APP_CTID` with an existing local solver ID or URL, delegating to guest `set-solver`. Implement `--update-solver APP_CTID --flaresolverr-ctid SOLVER_CTID` through the official guest `/usr/bin/update`, then rediscover/reconnect.
- [x] Run syntax, ShellCheck and mocked command-flow tests.

## Task 2: Native guest lifecycle (implementation agent)

- [x] Write lifecycle tests for command validation, build failure before cutover, backup failure, migration/readiness failure and configuration preservation.
- [x] Complete `scripts/proxmox/miaoyomi-native.sh`: install, update, update-suwayomi, set-solver, backup, status, logs and restart; root/Alpine guard; release staging and OpenRC supervision.
- [x] Consume `install --source-dir /root/miaoyomi-source --config /root/miaoyomi-install.conf`; config is a Bash-quoted, root-owned file with PUBLIC_ORIGIN, WEB_PORT, SOURCE_REPO, SOURCE_REF, MANGA_LIBRARY_PATH and external solver URL/optional CT ID. No local FlareSolverr package/runtime installation remains.
- [x] Install the manager at `/usr/local/sbin/miaoyomi`; build from bff/, web/, novel-engine/ lockfiles, using `PUPPETEER_SKIP_DOWNLOAD=true npm ci --include=dev` before build/pruning.
- [x] Keep `/etc/miaoyomi` settings and `/var/lib/miaoyomi` state; use CUSTOM_SITES_FILE and WEB_ROOT explicitly; service users separate app and novel secrets.
- [x] Implement `miaoyomi set-solver --url URL [--ctid ID]`, with an empty URL disabling the integration. Check an enabled endpoint before mutation, back up before replacing settings, preserve secrets/unrelated settings and update both BFF and Suwayomi. Retain the connection across app updates.
- [x] Include solver connection metadata in app backups while documenting that solver guest files/service data need a separate CT backup. Keep solver updates outside the app update lifecycle.
- [x] Verify shell syntax, ShellCheck and meaningful isolated lifecycle tests; report exact remaining environment limits.

## Task 3: Documentation and integration

- [x] Rewrite `docs/proxmox-lxc.md` for two-LXC installation, official solver wizard/updater, reconnect, source transport, networking, storage/UID mapping and separate CT backups.
- [x] Update README to make the native path primary while retaining the Compose alternative; label the remote one-liner as contingent on publication of these changes.
- [x] Add CI shell checks/tests and an honest native verification note.
- [x] Review integrated host/guest interface and security/failure paths; run complete installer test suite.

## Real-Proxmox acceptance (pending)

- [ ] Create and reboot both guests; verify Alpine OpenRC and Debian systemd services, private solver reachability and preserved upstream feature settings.
- [ ] Exercise the official wizard with a changed solver ID; repeat with an existing ID, external URL and solver disabled.
- [ ] Verify real manga/novel reading and browser challenge behavior independently of HTTP readiness.
- [ ] Exercise app update/backup, official solver update and reconnect after a changed solver address; preserve configuration, credentials, progress and books.
- [ ] Restore both CT backups and separately protected bind mounts, including reconnection after migration. Local mocked tests do not establish these results.
