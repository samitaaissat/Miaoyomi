# Verification record

This downstream is based on Uchiyomi commit `7407f4dab416724c65839b0e2e6a9f8ddfe45e55`. The approved design and comparison were written after reading all 16 visible messages in the supplied transcript. Fastify, account authentication, one PWA and the existing reverse-proxy/LXC topology were retained.

## Application and formats

| Check | Result |
| --- | --- |
| Web unit suite | 94 passed, 0 failed |
| Private novel-engine suite | 23 passed, 0 failed |
| Python configuration/backup suite | 8 passed, 0 failed |
| Novel archive/API/progress regressions against PostgreSQL | 32 passed, 0 failed |
| API route/OpenAPI/docs parity and upstream release manifests | 10 passed, 0 failed; new novel routes included in coverage |
| BFF TypeScript, web TypeScript/static export, engine bundle | Passed; 21 static web pages |
| Both source-built Docker images | `linux/amd64` builds passed; runtime and application booted |
| EPUBCheck 5.3.0 / EPUB 3.3 | Generated fixture, reordered archive and actual source-produced EPUB: zero fatal/errors/warnings |
| Independent ZIP/XML verification | Correct uncompressed first mimetype, CRCs, manifest, navigation, sorted spine and embedded assets |
| Full BFF regression suite | 774 tests: 773 passed, 0 failed, 1 skipped |
| Final manga title display follow-up | 7 focused PostgreSQL tests, BFF build and Chrome online/offline flow passed |

The first full BFF run had 771 tests: 765 passed, 5 failed, 1 skipped. The failures led to API documentation/coverage updates, preservation of upstream manifest links, and use of the centralized visibility predicate for immediate manga reads. One fill test also failed unchanged upstream: it waited for the CBZ file while its detached indexing job was still running. The fixture now waits for the job's completion and verifies the indexed chapter; production fill behavior and its assertions were retained. A subsequent repeat run also exposed an upstream fixture isolation issue on case-insensitive macOS: four scanner fixtures set only `DL_ROOT`, leaving `/library` to resolve to the host’s `/Library`. They now point both roots into temporary directories; 44 fixture tests followed by all 10 unchanged adult-library tests passed on the same clean database. The final suite uses a fresh database and an explicit empty default library root. The built-in backup integration test is skipped on this macOS host because native `pg_dump` is absent; the full backup/restore was separately exercised with Docker's PostgreSQL tools.

## Real source and browser checks

The production QuickJS worker and guarded networking successfully browsed/searched Royal Road and AO3, parsed public title metadata and retrieved chapter HTML. Royal Road returned 109 chapters for the tested title. The app fetched one selected chapter, wrote a 19,643-byte standard EPUB, exported it with bearer authentication and reopened the prose from that EPUB. Live ScribbleHub returned a typed Cloudflare challenge error. Some AO3 results require consent and correctly return an interstitial error; this is not counted as readable content.

The registry contains 278 pinned scripts; 249 compatible scripts successfully evaluated their metadata. This is a runtime-compatibility count, not a promise that 249 websites work. Engine tests use actual published source scripts and deterministic network responses. They also exercise private-IP/redirect/DNS checks, source cookies, headers, time/memory bounds, tampering, source activation, image signatures and guest isolation. Reviewed image request headers are respected; unsupported AVIF is explicitly refused while WebP is converted for EPUB.

A real Chrome browser drove the production static export and real BFF through login, an actual saved novel title, visible prose, 390-pixel layout, device download and immediate cold offline reopening **with the source engine stopped**. A separate repeatable browser fixture covers typed filters, pagination, authenticated EPUB export, chapter navigation/resume, account changes in the same tab, progress races and account-isolated offline libraries. Saving offline waits for acknowledged caching of the exact query-routed page shell. A real integration failure exposed a numeric/string archive revision mismatch; the frontend fixture now uses the server payload type and SHA-256 revision format.

Manga tests run the selected-chapter path against real PostgreSQL and the actual CBZ scanner, then verify the returned book ID and reader image endpoint. They cover duplicate chapter numbers (including Suwayomi alternate releases), provenance reuse, library/age/download permissions, source errors, trashed series and pool pressure. A repeatable Chrome fixture also drives real login, Discover, selection of one of two chapter-seven translations, the actual two-page image reader, device download and cold offline reopening with both images decoded from IndexedDB blob URLs. Immediate imports display the source chapter title rather than the archive identity hash; manual labels survive reuse and physical archive replacement. The existing optional full-series acquisition flow remains available.

## Deployment and restoration boundary

The host used here is macOS/Apple Silicon with Socktainer over Apple Container, rather than the user's x86 Linux LXC. `docker compose -f compose.yaml config --quiet` passes. Both `linux/amd64` app and engine images build, boot and pass health/API smoke checks. The final app image created an administrator, reached the private 278-source registry and wrote CBZ and EPUB fixtures as its configured nonroot application UID.

Socktainer's compatibility layer exposed three local limits: it does not consistently resolve Compose's platform-specific image IDs; newly created volumes do not inherit image directory ownership as standard Docker copy-up does; and its multi-network service DNS was unreliable. The successful local image smoke used initialized named volumes and direct container IPs. The production Compose retains normal Docker service DNS, nonroot engine restrictions and guest bind paths. No change to the user's actual Proxmox cluster or reverse proxy was made, and no image or remote GitHub fork was published.

The full backup script successfully archived PostgreSQL, configuration, CBZ/EPUB directories, enabled novel sources and Suwayomi state. Restore initially met macOS bind-mount ownership/time restrictions. Running the same restore implementation with disposable named volumes completed. The restored database had the same 41 public tables and server-settings row as the backup; the actual EPUB and CBZ bytes matched exactly. Empty top-level filesystem `lost+found` directories are preserved and tolerated; populated destinations and corrupt manifests are refused.

The committed Linux workflow additionally boots the actual Compose topology, seeds standard books, takes a full backup and restores it into a separate project with empty bind directories. It checks retained account setup state and byte-identical CBZ/EPUB contents. **That remote CI workflow has been added but has not been run by this task.**

## Reproduce

Use a disposable PostgreSQL database with `TEST_DATABASE_URL` and `TZ=UTC`, then run the commands in the root README. Upstream date parsing tests assume UTC; a Europe/Paris baseline run reproduced an existing absolute-date expectation mismatch. The supplied Compose fixes `TZ=UTC` for the app. For the browser fixtures, build `web/out` and run `node web/test/e2e/novels.mjs` with Chrome available. Run `MANGA_BROWSER_DATABASE_URL=postgres://test:test@localhost:5432/miaoyomi_browser_manga node web/test/e2e/manga-immediate.mjs` against a separate disposable database for the real manga API/reader/offline flow. Both fixtures accept `PUPPETEER_EXECUTABLE_PATH` or use an installed/bundled Chrome. For EPUBCheck, generate `bff/test/helpers/generateNovelEpub.cjs` with `node --import tsx` from the BFF directory and validate the emitted path with EPUBCheck 5.3.0.

The LXC setup and operational commands are in [deployment](proxmox-lxc.md) and [backup/restore](backup-restore.md). A development server serving a static export must restart after `web/out` is rebuilt, because the upstream static route registry snapshots hashed asset filenames at boot.
