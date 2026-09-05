# Miaoyomi

A self-hosted manga and webnovel PWA, built as a small downstream of [Uchiyomi](https://github.com/AngeloSha/uchiyomi). Browse a source, choose a title and chapter, and read. Server downloads use **CBZ for manga and EPUB for novels**. Device-offline reading is a separate, explicit download.

The deployment targets your **x86_64 Proxmox node**, behind your existing reverse proxy. One command creates an unprivileged **Alpine 3.24 LXC** and installs Node 24, PostgreSQL 18, Suwayomi and Miaoyomi as native OpenRC services. By default, it also runs the [official community FlareSolverr installer](https://community-scripts.org/scripts/flaresolverr) to create a **separate Debian LXC** and connects both manga components to it. No Docker or other container runtime runs inside either LXC. It retains Fastify and Uchiyomi accounts. A private LNReader/QuickJS runtime supplies prose sources; Suwayomi supplies manga extensions.

Run this single command as root in the **Proxmox node shell**:

```sh
bash -c "$(curl -fsSL https://raw.githubusercontent.com/samitaaissat/Miaoyomi/main/scripts/proxmox/create-lxc.sh)"
```

The wizard fetches this repository's `main` branch and configures resources, storage, network, HTTPS origin and an optional read-only existing manga mount. The app defaults to 4 cores, 6144 MiB RAM and 32 GiB disk; the official FlareSolverr wizard allocates its own guest. Use `--flaresolverr-ctid ID` to reuse a local native solver, `--flaresolverr-url URL` for an existing endpoint, or `--flaresolverr no` to disable it. `--nesting yes` enables the app LXC feature if needed; the solver keeps its upstream feature settings. Point your proxy at the app guest's selected port (default 8080), open the HTTPS hostname, create the administrator, then enable sources. Inside the app guest, use `miaoyomi status`, `miaoyomi backup` and `miaoyomi update` for maintenance; updates use the saved repository and branch.

No release tag, GitHub release, image publication or manually copied checkout is required for the native installation. Tags are optional when you want to pin a particular revision; see [source selection and updates](docs/proxmox-lxc.md#git-source-and-remote-one-liner). Native creation, boot and updates still require acceptance testing on a real Proxmox node. Existing deployments can keep the [Compose alternative](docs/proxmox-lxc.md#compose-alternative); native installation does not migrate Compose data.

## Compose

`docker-compose.yml` is the prebuilt deployment path. GitHub Actions publishes matching multi-architecture app and novel-engine images after a push to `main` or a `v*` tag. To start a released image pair:

```sh
cp .env.miaoyomi.example .env
bash scripts/miaoyomi-setup.sh --config-only
docker compose pull
docker compose up -d --wait
```

Both images use `MIAOYOMI_IMAGE_TAG` from `.env`, which defaults to `latest`; set one release tag on both services to update deliberately. GitHub creates a new Container package as private even when the source repository is public. After the first publish, set the two GHCR package pages to **Public** so deployment hosts can pull them anonymously.

For a source checkout, layer the development override over the prebuilt file instead:

```sh
MIAOYOMI_COMPOSE_MODE=dev bash scripts/miaoyomi-setup.sh --config-only
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build --wait
```

- [LXC deployment, storage, reverse proxy and cluster operation](docs/proxmox-lxc.md)
- [Native installation, update and recovery details](docs/proxmox-lxc.md#backup-recovery-and-cluster-operation)
- [Compose-only backup and safe restoration into an empty installation](docs/backup-restore.md)
- [Transcript requirements and comparison of the alternatives](docs/research/2026-09-05-reader-options.md)
- [Approved architecture](docs/superpowers/specs/2026-09-05-miaoyomi-design.md)
- [Novel runtime compatibility and pinned source provenance](novel-engine/README.md)
- [Verification results and remaining environment limits](docs/verification.md)
- [Original Uchiyomi documentation](README.upstream.md)

The retained upstream deployment manifests are [Unraid](deploy/unraid/uchiyomi.xml), [Umbrel](deploy/umbrel/uchiyomi) and [CasaOS](deploy/casaos/docker-compose.yml). They install upstream Uchiyomi; use this repository's native installer, `docker-compose.yml` for published images, or the development overlay for Miaoyomi's novel features.

Manga chapters are fetched individually into standard CBZ files and opened in the existing image reader. Novel chapters are sanitized and inserted atomically into a standard EPUB with a navigation document, reading order and embedded assets. The prose reader supports fonts, themes, chapter navigation, progress and account-scoped offline storage. A failed device download never marks an incomplete copy as ready.

The vendored LNReader registry contains 278 published scripts. 249 pass metadata compatibility evaluation; website availability is separate. Royal Road and public guest-readable AO3 works were live-tested. Some sites require browser capabilities, consent or challenge solving that this runtime does not provide; those failures are explicit. The runtime begins with sources disabled and keeps plugins away from the database and library volumes.

This checkout is based on Uchiyomi `7407f4dab416724c65839b0e2e6a9f8ddfe45e55`. The [MPL-2.0 license](LICENSE) remains in place; LNReader source and library licenses are retained under `novel-engine/vendor`. The configured public project remote is `samitaaissat/Miaoyomi`; its first publishing workflow run creates the two GHCR packages.

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
