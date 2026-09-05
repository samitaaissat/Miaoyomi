# Full backup and restore

Miaoyomi's full backup includes PostgreSQL, both manga directories, EPUBs, app configuration, enabled novel plugins, Suwayomi state and `.env`. Uchiyomi's built-in nightly backup covers only database/configuration; it is not a complete book-library backup.

Run the following **inside the LXC**, from the checkout. Choose a new directory outside every library path, on your backup storage:

```sh
python3 scripts/miaoyomi-backup.py backup /mnt/backups/miaoyomi-2026-09-05
```

The script records which writers are running, stops them, takes a PostgreSQL custom-format dump, archives each volume and verifies each completed artifact with a SHA-256 manifest. It restarts the services that were running even if backup fails. A directory without `manifest.json` is incomplete. Keep the backup private: it contains credentials and books. Copy it off the guest according to your existing backup policy. Run during a quiet period; readers are unavailable for the duration.

Restore into a **new empty** installation; the command refuses a nonempty database or destination volume. Use the same checkout revision and PostgreSQL major version initially. The image must already have been built or loaded.

1. Place a trusted complete backup on the new guest. Copy `configuration.env` from it into the new checkout as `.env`, retaining file mode 600. Adjust private IP, public origin and library paths for the new guest. Keep paths empty and do not point to the old running instance.
2. Run `bash scripts/miaoyomi-setup.sh --config-only` to prepare empty bind directories, then `docker compose -f compose.yaml build` to build the app and runtime. Keep writers stopped.
3. Restore and start:

```sh
python3 scripts/miaoyomi-backup.py restore-empty /mnt/backups/miaoyomi-2026-09-05
docker compose -f compose.yaml up -d --wait
```

The restore verifies the manifest before restoring, checks every destination is empty, starts PostgreSQL, restores files with their archived ownership, then restores the database in a transaction. It does not overwrite `.env` for you. A failed restore may leave partially populated file volumes: inspect the error and use another empty destination; there is no automatic destructive rollback.

Verify an account login, library counts, a saved manga chapter, a saved novel chapter with the source engine stopped, and recent reading progress before switching your proxy. CBZs and EPUBs can also be opened by other standard readers independently of the database.

For Proxmox snapshots, stop the app and source writers for an application-consistent snapshot, or use this script. Ensure both the guest's named Docker volumes and any host/NAS bind mounts are included. Do not assume a VM/CT snapshot includes external mounts.
