# Reader architecture evaluation

Evaluated 5 September 2026 against the complete visible [ChatGPT conversation](https://chatgpt.com/share/6a9b8b99-78f0-83eb-a941-e7a7ea786358): seven user messages and nine assistant messages, including two interim assistant updates. The shared page also contains redacted tool messages; these do not expose their original research results. Current project claims below were checked independently.

## Requirements that control the design

The final user clarification overrides the conversation's early recommendations of an acquisition pipeline. The required experience is **source plugins → discover/search → title → chapter → read immediately**, for both manga and prose webnovels.

- Self-hosted, browser first, installable PWA; usable on phones and computers.
- Optional device-side offline reading. A server download alone does not meet this requirement.
- A dedicated reader subdomain; Nextcloud can link to it as a portal.
- Reuse community source plugins instead of maintaining a collection of bespoke scrapers.
- No requirement to paste story URLs, operate a download manager, or obtain an EPUB before reading.
- Current additional instruction: any reading content persisted on the server uses **CBZ for manga and EPUB for novels**, generated from plugins/sources. Catalog metadata and reading progress can remain in a database.

Royal Road, Scribble Hub, AO3 and other source names were examples discussed by the previous assistant, not a user-specified mandatory source list. Plugin availability must not be mistaken for verified live compatibility.

## Recommendation

Use a small downstream fork of **Uchiyomi**, retain its manga stack and add prose support behind an independent LNReader plugin service. This preserves one frontend, account system and installable PWA while separating the two incompatible plugin runtimes. Keep novel content in standard EPUB files and progress in the existing Postgres database.

The alternatives evaluated here do not already implement the whole requested experience. A compose file alone cannot add the missing prose source runtime, reader, offline behavior or EPUB generation.

## Corrections to the conversation

1. **Koryomi is the former name of Uchiyomi**, not a separate alternative. The [old repository URL](https://github.com/AngeloSha/koryomi) redirects to [AngeloSha/uchiyomi](https://github.com/AngeloSha/uchiyomi); GitHub's API reports the same canonical repository.
2. Uchiyomi now integrates **Suwayomi as a Mihon/Tachiyomi extension engine**, so the conversation's claim that choosing it sacrifices that ecosystem is outdated. Uchiyomi owns the library and downloads; Suwayomi resolves sources and pages. [Extension architecture](https://github.com/AngeloSha/uchiyomi/blob/7407f4dab416724c65839b0e2e6a9f8ddfe45e55/docs/extensions.md).
3. Uchiyomi's **image EPUB** support is not a prose reader. Its current README explicitly excludes reflowable text ebooks. [Current README](https://github.com/AngeloSha/uchiyomi/blob/7407f4dab416724c65839b0e2e6a9f8ddfe45e55/README.md).
4. Neyomi documents that its PWA does **not** provide chapter reading offline. An installable shell is not sufficient. [Neyomi README](https://github.com/omar-anwari/Neyomi).
5. The official LNReader site reports 278 plugins; this is the registry's displayed count, not a compatibility promise for a new server host. [Registry](https://www.lnreader.app/plugins).

## Comparison

| Basis | Fit for this request | Missing work or decisive limitation |
| --- | --- | --- |
| **Uchiyomi (formerly Koryomi)** | Best overall foundation: manga source discovery, PWA, device offline, multi-user accounts, CBZ archive, optional Suwayomi engine | Prose source runtime, text reader, EPUB storage and novel offline/progress integration; young project, created June 2026 |
| **Suwayomi + stock WebUI/VUI** | Strong manga source engine and replaceable browser clients | Prose runtime and reader still absent; server downloads do not establish browser offline support |
| **Suwayomi + Neyomi** | Attractive mobile PWA over Suwayomi's GraphQL API | No chapter offline support, no prose, and no license declaration found in the reviewed repository |
| **Tsumiru / Catalyst** | Suwayomi clients with native device offline reading | Tsumiru explicitly excludes its web build from offline support; Catalyst's releases are native clients; neither adds prose plugins |
| **LNReader** | Best plugin ecosystem to target for prose: popular/latest, search, metadata, chapter parsing, filters | Android app, not a self-hosted server/PWA |
| **Tsundoku** | Native Android manga and novels, including LNReader extensions | Does not satisfy the self-hosted browser/PWA requirement |
| **IReader** | Native Android/desktop novel reading and source ecosystems | Does not supply the requested self-hosted PWA |
| **Hayai** | Promising native integration of manga and novel sources | No stable release documented and no self-hosted PWA |
| **Kavita / Komga** | Useful independent consumers of standard library files | Library servers, not the requested novel-site source discovery runtime |
| **FanFicFare / AutomatedFanfic** | Download/update known story URLs into ebooks | The URL/acquisition pipeline the user explicitly rejected |
| **WebToEpub** | Browser extension producing standard EPUBs | Not a self-hosted source catalog or integrated reader |
| **Storyteller** | Existing ebooks and synchronized narration | No novel source ecosystem; web reader experimental and PWA offline unsupported |
| **Readarr** | Former ebook collection manager | Retired; never supplied this chapter-reading experience |

Primary references: [Suwayomi](https://github.com/Suwayomi/Suwayomi-Server), [WebUI](https://github.com/Suwayomi/Suwayomi-WebUI), [VUI](https://github.com/Suwayomi/Suwayomi-VUI), [Tsumiru offline guide](https://tsumiru.app/docs/guides/offline-reading), [Catalyst](https://github.com/just-for-death/catalyst), [LNReader](https://github.com/LNReader/lnreader), [LNReader plugins](https://github.com/LNReader/lnreader-plugins), [Tsundoku](https://github.com/tsundoku-otaku/tsundoku), [IReader](https://github.com/IReaderorg/IReader), [Hayai](https://github.com/HayaiApp/hayai), [Kavita](https://github.com/Kareadita/Kavita), [Komga](https://github.com/gotson/komga), [FanFicFare](https://github.com/JimmXinu/FanFicFare), [AutomatedFanfic](https://github.com/MrTyton/AutomatedFanfic), [WebToEpub](https://github.com/dteviot/WebToEpub), [Storyteller web reader](https://storyteller-platform.dev/docs/reading/web-reader/), [Readarr retirement](https://github.com/Readarr/Readarr).

## Fork versus a companion application

**Small Uchiyomi fork — recommended.** Add a novel module and UI routes while retaining the upstream manga model. Put third-party novel plugin execution in a separate service. This needs a maintained downstream patch but avoids rebuilding the existing reader, accounts and offline manga. Keep the original MPL-2.0 license and upstream attribution. A local downstream branch does not require publishing a GitHub fork.

**Unmodified Uchiyomi plus a separate novel PWA.** Easiest to upgrade the manga application, but produces two apps, two offline shells and extra account/integration work. It does not deliver the unified reader discussed in the transcript.

**A new frontend over Suwayomi plus a novel service.** Clean backend separation and full presentation control, but requires rebuilding the manga offline experience and account integration as well as the missing prose functionality. Larger initial work than extending Uchiyomi.

## Evidence and boundaries

- Uchiyomi source inspected at `7407f4dab416724c65839b0e2e6a9f8ddfe45e55` (4 September 2026), app version `0.19.0`; MPL-2.0. Repository metadata records creation on 23 June 2026.
- The current deployment supports an embedded Postgres or an external database. A dedicated Postgres service gives the new module a clear persistence and backup boundary. The development compose builds source; a downstream modification cannot use an unchanged upstream released image and expect the new feature to exist.
- Source docs and README disagree about whether an extension repository is preconfigured. Installation instructions should show the actual source setup UI and verify behavior, rather than promise every source is ready on first boot.
- LNReader's published plugin interface is JavaScript, but it depends on host modules and network/storage helpers. Browser/WebView-dependent plugins need explicit capability reporting; simply evaluating a script is not complete compatibility.
- Nextcloud should link to the dedicated HTTPS origin. Iframe embedding is optional and depends on framing headers/cookies; it should not be a dependency of the PWA. [Nextcloud External sites](https://docs.nextcloud.com/server/stable/admin_manual/configuration_server/external_sites.html).
