# Miaoyomi

A self-hosted manga and webnovel PWA, built as a small downstream of [Uchiyomi](https://github.com/AngeloSha/uchiyomi). Browse a source, choose a title and chapter, and read. Server downloads use **CBZ for manga and EPUB for novels**. Device-offline reading is a separate, explicit download.

The deployment targets your **x86 Proxmox LXC**, behind your existing reverse proxy. It retains Fastify and Uchiyomi accounts. A private LNReader/QuickJS runtime supplies prose sources; Suwayomi supplies manga extensions. PostgreSQL stores metadata, accounts and progress.

```sh
bash scripts/miaoyomi-setup.sh --config-only
# Edit .env: guest private IP, HTTPS PUBLIC_ORIGIN, library paths and ownership.
bash scripts/miaoyomi-setup.sh
```

Open the configured HTTPS hostname, create the administrator, then enable your novel sources in **Novels** or configure manga sources in the existing admin interface. The default app binding is localhost port 8080. Use `docker compose -f compose.yaml` for this downstream stack.

- [LXC deployment, storage, reverse proxy and cluster operation](docs/proxmox-lxc.md)
- [Full backup and safe restoration into an empty installation](docs/backup-restore.md)
- [Transcript requirements and comparison of the alternatives](docs/research/2026-09-05-reader-options.md)
- [Approved architecture](docs/superpowers/specs/2026-09-05-miaoyomi-design.md)
- [Novel runtime compatibility and pinned source provenance](novel-engine/README.md)
- [Verification results and remaining environment limits](docs/verification.md)
- [Original Uchiyomi documentation](README.upstream.md)

The retained upstream deployment manifests are [Unraid](deploy/unraid/uchiyomi.xml), [Umbrel](deploy/umbrel/uchiyomi) and [CasaOS](deploy/casaos/docker-compose.yml). They install upstream Uchiyomi; use this repository's `compose.yaml` for Miaoyomi's novel features.

Manga chapters are fetched individually into standard CBZ files and opened in the existing image reader. Novel chapters are sanitized and inserted atomically into a standard EPUB with a navigation document, reading order and embedded assets. The prose reader supports fonts, themes, chapter navigation, progress and account-scoped offline storage. A failed device download never marks an incomplete copy as ready.

The vendored LNReader registry contains 278 published scripts. 249 pass metadata compatibility evaluation; website availability is separate. Royal Road and public guest-readable AO3 works were live-tested. Some sites require browser capabilities, consent or challenge solving that this runtime does not provide; those failures are explicit. The runtime begins with sources disabled and keeps plugins away from the database and library volumes.

This checkout is based on Uchiyomi `7407f4dab416724c65839b0e2e6a9f8ddfe45e55`. The [MPL-2.0 license](LICENSE) remains in place; LNReader source and library licenses are retained under `novel-engine/vendor`. No remote fork is required to run it. A downstream GitHub fork is useful if you want to maintain/publish it; this task has not created or pushed one.

Development checks:

```sh
npm --prefix bff ci
npm --prefix web ci
npm --prefix novel-engine ci
TZ=UTC LIBRARY_ROOT="$(mktemp -d)" TEST_DATABASE_URL=postgres://test:test@localhost:5432/miaoyomi_test npm --prefix bff test
npm --prefix web test
npm --prefix novel-engine test
npm --prefix bff run build
npm --prefix web run build
```

Use a disposable test database. Source integration and archive tests run against real PostgreSQL; the frontend exports static routes. The LNReader engine uses Node 24; the app uses Node 22 or newer.
