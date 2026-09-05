# Miaoyomi: source-based manga and novel PWA

Status: approved by the user on 5 September 2026, with deployment revised to x86 LXC on their three-node Proxmox cluster behind their existing reverse proxy. The user confirmed Fastify stays; they had initially read its name as Fastly. Existing application authentication remains part of the approved design. This document is a design, not a completion claim.

## Outcome

Open one self-hosted PWA, select Manga or Novels, browse an installed source or search it, open a title, and start a chapter. Save selected chapters to the device for offline reading. Resume reading later with the same account on another device.

Any manga or novel reading content persisted on the server is stored in **CBZ or EPUB**, respectively. The user does not need to manipulate these files in order to read.

The [options evaluation](../../research/2026-09-05-reader-options.md) derives this scope from the complete shared conversation and compares the alternatives. This is an architectural extension to an existing application, with two independently testable additions: the novel plugin runtime, and the novel library/reader backed by standard EPUB files.

## Chosen foundation and alternatives

**Recommended:** a local downstream branch of Uchiyomi at source commit `7407f4dab416724c65839b0e2e6a9f8ddfe45e55`, with a private LNReader plugin service. Retain the upstream MPL-2.0 license and attribution. Record the upstream remote and base revision so later updates can be merged deliberately. Publishing a GitHub fork is a separate optional action.

The first alternative is unmodified Uchiyomi plus a separate novel application. It reduces manga maintenance but gives the user two applications and offline shells. The second is a new PWA over Suwayomi and a novel service; it requires rebuilding the manga device-offline and account experience. The recommended fork preserves those existing capabilities while keeping most new code in a separate novel module.

## Architecture

```text
Browser / installed PWA
          |
HTTPS read.example.com (user's existing reverse proxy)
          |
Miaoyomi: Uchiyomi frontend + authenticated Fastify API
          |
          +-- Manga module -------- Suwayomi extension engine ---- manga sources
          |         |
          |         +-- standard CBZ library
          |
          +-- Novel module -------- private LNReader runtime ---- novel sources
          |         |
          |         +-- standard EPUB library
          |
          +-- private Postgres: accounts, catalog, source settings, progress

Browser IndexedDB: account-scoped offline chapters and pending progress
```

The existing manga model remains image-based. Novel series, logical chapters and prose locators have their own model: a novel EPUB can contain many logical chapters and grows as chapters are requested. It must not be fed to Uchiyomi's image-EPUB scanner as though it were one manga chapter.

The novel runtime has no database credentials or library mounts. It returns temporary normalized metadata and chapter content to the authenticated application. Only the application reads and writes EPUBs. The runtime API is private to the compose network and authenticated with a generated service token.

## Source plugin runtime

Target the official LNReader v3 published plugin contract and registry, with a pinned registry revision recorded in the build/lock metadata. Installed source code is retained with its version and a SHA-256 digest. Source updates are explicit administrative actions; replacing a plugin must not silently re-key saved novels.

Published plugins are CommonJS modules exporting an instantiated plugin as `exports.default`; they are not standalone browser scripts. Implement the host interface needed for these methods:

- `popularNovels(page, { showLatestNovels, filters })` for popular and latest catalogs where the source offers them.
- `searchNovels(query, page)` for search; this method does not universally accept browse filters.
- `parseNovel(path)` for metadata and the first chapter list.
- Optional `parsePage(novelPath, page)` for paginated chapter lists.
- `parseChapter(path)` for source chapter HTML.
- Optional `resolveUrl(path, isNovel)` for source links.

Preserve plugin filter definitions and their typed `{ type, value }` values, including include/exclude checkboxes. Do not expose a Latest or filter control unless the source supports it. Preserve plugin chapter order and stable source paths; do not derive identities solely from titles or chapter numbers.

Execute plugin JavaScript inside a QuickJS guest with a memory limit and interrupt deadline, wrapped in the separate service. Bundle supported pure JavaScript dependencies into the guest: Cheerio, htmlparser2, dayjs and the LNReader constant/filter/storage helpers required by the tested sources. Network calls cross a host-controlled asynchronous bridge; the guest receives no Node `require`, process, filesystem or socket access. A Node `vm` context is not an acceptable security boundary.

Host HTTP enforces allowed public source/API/CDN origins, rejects local/private/link-local IPs, validates every redirect and resolved destination, limits response sizes and request duration, and maintains source-scoped cookies. Implement all network entry points a supported plugin uses through that bridge. Unsupported imports, WebView execution or browser-only challenge requirements produce a clear compatibility result; they must not silently return an empty catalog.

Initial real-source acceptance targets are the official **Royal Road** and **AO3** plugins: both have completed browse, search, details and chapter parsing in independent server-host experiments. Scribble Hub currently answers with a Cloudflare challenge from this environment; report it as blocked until actually verified. Registry membership alone does not establish runtime or live-site compatibility. The architecture permits broader compatible sources without implementing new site-specific scrapers.

The application offers the registry and source status in its source-management screen, and only enabled compatible sources appear in normal discovery. Challenge solving is an optional extension to the transport. Do not promise to bypass CAPTCHAs, source logins or paid chapters; failures retain their source and useful explanation.

## Standard server storage

**Manga:** retain Uchiyomi's existing plugin → images → CBZ download path, including its library metadata conventions. Add a source chapter-list endpoint and an open-chapter action which fetches exactly the selected chapter, creates its CBZ, and opens the image reader. This must not require a full-series import or subscription. Existing source Add defaults to a series download and is not sufficient for the requested immediate reading flow.

**Novels:** one valid EPUB 3 archive per source novel, containing the chapters actually fetched. Opening a chapter can create or extend this EPUB without downloading the entire novel first. Export/download controls clearly distinguish saved chapters from the source's complete chapter list.

Each EPUB contains the first, uncompressed `mimetype` entry, `META-INF/container.xml`, package metadata/manifest/spine, `nav.xhtml`, well-formed XHTML chapters and supported embedded images/styles. Supply a stable identifier, title, language, modified timestamp, author when supplied, and source provenance. Use stable chapter filenames derived from source identity/path and order the spine according to the source chapter list. Rewrite embedded asset references to local EPUB resources; do not ship active scripts, forms, event handlers or source tracking resources.

References: [EPUB 3.3](https://www.w3.org/TR/epub-33/) and [EPUBCheck](https://github.com/w3c/epubcheck). Validate generated archives with EPUBCheck in addition to structural tests. A renamed ZIP or HTML file is not sufficient.

Raw chapter HTML may exist briefly in memory during retrieval and sanitization. Durable reading content exists only in EPUB/CBZ. Database rows contain metadata, source paths, archive references and progress, with no permanent chapter-body column. Transport response caches must not persist reading bodies to arbitrary files.

Serialize updates per novel using a Postgres lock, re-open the latest archive inside the lock, write and sync a temporary complete EPUB beside the destination, then atomically rename it. Update catalog metadata after the artifact replacement. On access after interruption, reconcile from the standard archive so a successful file replacement followed by a failed metadata commit cannot lose a chapter or produce a broken pointer. Never replace a valid EPUB with a failed or incomplete download.

Provide authenticated EPUB export for saved chapters and document the server library path, so files can also be read by standard readers independently of Miaoyomi. No automatic full-book monitoring pipeline is required by this design.

## Catalog, accounts and progress

Add separate novel catalog, chapter metadata, source registration, user-library and progress tables. Reuse Uchiyomi authentication, admin roles and relevant source-access controls. A source identifier plus source path determines a stable novel or chapter identity. Preserve separate editions/translations from different sources; do not deduplicate by title alone.

Progress records identify the user, novel, chapter and a prose position (paragraph/anchor plus scroll fraction), along with completion and update metadata. Completed chapters do not become unread because a delayed offline position arrives. Pending updates are owned by the account that created them and cannot be replayed under another user's login. Keep source cookies and reading state out of public unauthenticated endpoints.

## PWA and reader

Add a clear Manga/Novels switch within the existing shell and matching access on mobile. The novel area includes source selection, popular/latest browsing when supported, search, plugin filters, title details, full/paginated chapter list, saved library and Continue Reading.

The prose reader offers adjustable text size, line height, reading width, light/sepia/dark themes, chapter navigation and automatic position saving. Render sanitized chapter content inertly; no source JavaScript or custom source CSS executes in the application origin. Source errors include retry behavior and do not discard the existing library.

Offline downloads save account-scoped derived chapter payloads, embedded assets and navigation metadata in IndexedDB. This is a device cache; the server standard-file rule still applies to EPUB/CBZ. Mark a chapter available only after all required assets are stored. Handle quota exhaustion and allow removal of selected downloads.

Precache the reader's required application assets and preserve route-correct navigation in the service worker. A downloaded chapter must open after closing and reopening the PWA with both server and source network access unavailable. Reuse the existing account restoration rules and ensure signed-out users or another signed-in account cannot read a previous account's downloads. Flush pending progress on reconnect and foreground launch; background sync is an enhancement, not a dependency on iOS.

## Docker and operations

Provide a default `compose.yaml` that builds the downstream application from this checkout, a private Postgres service, the private novel runtime and the pinned Suwayomi engine. Persist database state, plugin registrations and Suwayomi state in named volumes. Store standard libraries in separate documented bind mounts, including `NOVEL_LIBRARY_PATH` for EPUBs, outside the manga scanner root. Keep database, source engines and runtime ports unpublished.

Target Linux amd64/x86 in an LXC guest on the user's existing three-node Proxmox cluster. Supply a configurable app bind address/port for their reverse proxy to reach on the private LAN; use loopback for local development. The existing proxy terminates HTTPS; do not add Caddy or Nextcloud services. The cluster is a deployment location, not an instruction to invent active-active replication or Kubernetes. Run one application/database stack in one LXC, with documented persistent mounts and host-level backup/restore or Proxmox HA placement. Add readiness checks, bounded resource usage, graceful stop time and deterministic image/dependency versions.

The current machine has Docker CLI and Apple Container/Socktainer installed, but the container service is stopped. Start the local runtime for integration verification when implementing; report any actual platform incompatibility. Configuration validation alone must not be presented as a successful container startup.

Document initial admin setup, source activation, HTTPS/PWA installation, standard library access, backups/restoration, updates and the upstream-fork maintenance procedure. Backups include Postgres, CBZ/EPUB files, source settings and engine state. A database-only backup does not back up the books.

Nextcloud is a navigation link to the reader's own origin. A native Nextcloud app and iframe-dependent installation are outside this scope.

## Verification and completion criteria

1. Run the existing Uchiyomi unit suites and builds before and after integration; distinguish tests requiring a live Postgres database from skipped tests.
2. Test real published LNReader scripts against deterministic HTTP fixtures for catalog, search, typed filters, metadata, chapter pagination and chapter content. Add runtime deadline, unsupported-module and network-boundary tests.
3. Run opt-in live Royal Road and AO3 checks and report source/challenge failures honestly; do not make the normal suite depend on source uptime.
4. Test EPUB creation, append, chapter ordering, sanitization, embedded assets, concurrent appends, interrupted updates and recovery. Validate representative output with EPUBCheck and open it in an independent EPUB-capable reader or parser.
5. Exercise authenticated source → novel → chapter → read → save offline in a real browser. Restart the page with network disabled and verify content/navigation. Reconnect and verify progress; test account switching and quota/download failure handling.
6. Verify existing manga CBZ reading and device offline still work after the shared-shell/service-worker changes.
7. Validate compose, build images and run the stack with health checks; test backup restoration into separate disposable storage. Keep source engines private.
8. Review the implementation independently for contract, storage and integration gaps. Deliver a runnable checkout, passing checks with explicit limitations, and concise startup instructions.

## Explicit scope boundaries

The initial implementation does not claim compatibility with every LNReader plugin or every source's anti-bot system. It does not build native clients, DRM removal, a recommendation model, translation/OCR, a full ebook editor, arbitrary custom-plugin uploads, a Nextcloud application, or a new manga scraper ecosystem. EPUB export contains available saved chapters; full-book prefetch is not required to begin reading.

## Process checklist

- [x] Read the full visible conversation and extract the final user requirements.
- [x] Inspect the empty workspace and current upstream source.
- [x] Compare the transcript's options and correct outdated claims.
- [x] Investigate LNReader's actual published interface and live host feasibility.
- [x] Incorporate the user's CBZ/EPUB storage instruction.
- [x] Produce and self-review this concrete architecture.
- [x] Obtain architecture approval; user approved everything except the API/auth phrasing and specified x86 LXC/Proxmox behind an existing reverse proxy.
- [ ] Write the implementation plan and establish the downstream branch.
- [ ] Implement, review and verify the complete application and deployment.
