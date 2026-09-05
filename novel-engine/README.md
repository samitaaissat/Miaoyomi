# Private LNReader engine

Internal Fastify service for Miaoyomi. It executes **digest-verified published LNReader v3 plugins in QuickJS**, with narrowly reviewed source compatibility shims where a site has migrated or changed its response envelope. Cheerio, htmlparser2 and dayjs are bundled into the guest. Each invocation runs in a worker with an independent hard deadline; the worker receives no environment variables. Guest code has no Node, filesystem, OS, environment or unrestricted module access. Network requests cross a JSON-only bridge to the guarded host broker.

## Run

Node 24 or later:

```sh
cd novel-engine
npm ci
npm run build
export NOVEL_ENGINE_TOKEN='replace-with-a-long-random-shared-token'
export NOVEL_ENGINE_STATE_DIR='./state'
# Optional shared browser solver for challenged sources:
export FLARESOLVERR_URL='http://127.0.0.1:8191'
npm start
```

The service listens on port **4100** (`PORT` overrides), bound to `HOST` (default `0.0.0.0`; use `127.0.0.1` for native local tests). Keep it on the private Compose network; the authenticated BFF is its public boundary. `NOVEL_ENGINE_TOKEN` must equal the BFF's engine token. All sources initially are disabled; activate them through the BFF admin UI or the private route:

```sh
curl -H "Authorization: Bearer $NOVEL_ENGINE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' \
  http://localhost:4100/v1/sources/royalroad
```

`docker build -t miaoyomi-novel-engine:local novel-engine` from the repository root creates the Node 24 Alpine image for the local host architecture. GitHub Actions publishes matching multi-architecture variants for deployments. It runs as the `node` user. Mount only a writable configuration directory at `/state`, owned by uid/gid **1000:1000** (initialize/chown externally when a volume provider does not preserve image-directory ownership); use a read-only root filesystem, dropped capabilities, `no-new-privileges`, and container CPU/memory limits in Compose. There is no library or database mount. The existing reverse proxy should reach the BFF, not this service.

## Contract

Every endpoint except `GET /healthz` requires `Authorization: Bearer <token>`. Authentication compares fixed-length SHA-256 values with `timingSafeEqual`.

| Endpoint | Request / response |
| --- | --- |
| `GET /healthz` | `{ok:true}` |
| `GET /v1/sources` | `{sources:EngineSource[]}` |
| `GET /v1/sources/:id` | `{source:EngineSource}` including runtime filter definitions |
| `POST /v1/sources/:id` | `{enabled:boolean}` → `{source}` |
| `POST /v1/invoke` | `{sourceId,method,args}` → `{result}` |
| `POST /v1/asset` | `{sourceId,url}` → binary image with validated MIME/signature |

Allowed methods: `popularNovels`, `searchNovels`, `parseNovel`, `parsePage`, `parseChapter`, `resolveUrl`. Missing optional plugin methods return 409. LNReader method argument order is preserved. Browse takes `[page,{showLatestNovels,filters}]`, search takes `[term,page]`, detail/chapter take `[path]`, and `parsePage` takes `[path,pageString]`. Browse merges supplied filter wrappers with plugin defaults. Filters retain `{type,value}`; they are not flattened.

Failures use `{error,message}`: 400 invalid call, 401 invalid token, 404 unknown source, 409 disabled/unsupported capability, 502 source/network/challenge errors, 503 full engine queue, 504 deadline. `SITE_CHALLENGE` and `SOURCE_INTERSTITIAL` distinguish unsolved browser challenge/consent/login pages. `SOLVER_UNAVAILABLE`, `SOLVER_UNSUPPORTED` and `SOLVER_BUSY` identify solver failures, unsupported request methods/media types and capacity limits. Solver HTTP errors include the bounded error message returned by FlareSolverr. HTTP failure cannot become a successful empty scrape even if a plugin catches fetch exceptions.

## Network and execution limits

- Only HTTP(S), standard ports and approved **exact origins** are accepted. All DNS answers must be public unicast; IPv4-mapped IPv6 is rejected. Direct requests connect to their validated DNS address, while preserving hostname/TLS verification. Every direct redirect revalidates origin and DNS. Solver requests validate the initial and returned final URL; see the browser trust boundary below.
- Five direct redirects shared with any recovery retry, 12-second direct network deadline, 5 MiB decoded response, 64 KiB text request body, 32 fetches per invocation; hop-by-hop, host, authorization and user-supplied cookie headers are not forwarded. Solver calls have a 50-second solve budget inside a 60-second HTTP limit, allowing time for browser startup/cleanup, a bounded JSON envelope and the same decoded page limit. A network request including the default solver queue wait and recovery is capped at 102 seconds.
- Cookies are in-memory, source-scoped public-guest jars with domain/path/secure matching; no account login API. Cookie count and size are bounded. Redirect cookies are retained.
- QuickJS: 64 MiB heap, 1 MiB stack, 20-second wall-clock limit (110 seconds when a solver is configured). Worker: 128 MiB V8 heap and a host hard kill deadline. Four concurrent operations by default (`NOVEL_ENGINE_CONCURRENCY`), with up to 32 waiting requests (`NOVEL_ENGINE_QUEUE_LIMIT`) and a 30-second queue deadline (`NOVEL_ENGINE_QUEUE_TIMEOUT_MS`). Same-source invocations serialize their transient KV snapshot without blocking unrelated sources. Disconnected requests leave the queue or cancel their active worker and network requests. The BFF permits 150 seconds per engine call to cover both waiting and execution.
- `setTimeout`, `setInterval` and their clear functions use bounded host scheduling with callback arguments, real elapsed delays and at most 1024 active timers. Timers are discarded when the invocation completes or reaches its deadline; they cannot outlive the worker.
- Plugin KV storage is source-scoped, in-memory only, limited to 256 KiB with a 15-minute reuse TTL. It is never written to configuration storage. A new isolate is created for each call, so other arbitrary plugin instance state does not survive calls.
- Plugin output: at most 8 MiB. Assets accept PNG, JPEG, GIF or WebP only when their signature matches the reported MIME type; AVIF, SVG and HTML are rejected. This matches the BFF archive path, which converts WebP to portable PNG inside the EPUB.
- Published `imageRequestInit` defaults (such as an image Referrer header) are loaded privately from the plugin and applied through the same request/header allowlist. They cannot override the destination host, provide Authorization or inject cookies; source-scoped cookie matching remains the broker's responsibility.

Source-site origins are allowed by default. Arcane's reviewed canonical origin is now `https://noveldex.io`. The server adds Royal Road's reviewed cover CDN origins `https://www.royalroadcdn.com` and `https://royalroadcdn.com`. `NOVEL_ENGINE_ALLOWED_ORIGINS` may supply an administrator-reviewed JSON map of source IDs to additional exact origins; entries override the defaults for their source while retaining other sources' defaults. This never relaxes public-IP checks. A plugin needing an unapproved API/CDN produces an explicit `NETWORK_POLICY` failure.

## FlareSolverr

Set `FLARESOLVERR_URL` to a trusted HTTP(S) solver origin; unset or empty disables it. Ordinary text requests use direct HTTP first. On a detected Cloudflare/DDoS-Guard challenge, the engine asks FlareSolverr to GET the URL for clearance, then retries the original guarded request once with matching cookies and the solver user agent. This preserves the actual response status, content type and JSON body. POST recovery preserves the original body and headers without also submitting a browser POST. A successful direct request is never replayed.

Browser sessions are reused per source and origin, including browser storage and cookies; the direct client also retains clearance cookies and the matching browser user agent. Simultaneous clearance requests for the same source/origin share a solve, then retry their own URLs. Browser sessions are isolated between sources and origins, bounded, and destroyed on eviction, expiry, failure or graceful shutdown. They are guest sessions in memory, not persisted account logins.

| Setting | Default | Purpose |
| --- | --- | --- |
| `NOVEL_SOLVER_CONCURRENCY` | `2` | Simultaneous novel browser requests |
| `NOVEL_SOLVER_QUEUE_LIMIT` | `32` | Maximum waiting browser requests |
| `NOVEL_SOLVER_QUEUE_TIMEOUT_MS` | `30000` | Maximum browser queue wait |
| `NOVEL_SOLVER_SESSION_LIMIT` | `4` | Maximum retained browser sessions |
| `NOVEL_SOLVER_SESSION_IDLE_MS` | `600000` | Close sessions idle for ten minutes |
| `NOVEL_SOLVER_SESSION_TTL_MINUTES` | `15` | FlareSolverr browser-session TTL |

These limits apply to the novel engine; leave capacity for manga consumers sharing the same FlareSolverr. Native installations read overrides from `/etc/miaoyomi/novel.env`; Compose forwards them from its environment.

Explicit `fetchWebView` or `useWebView: true` requests return rendered UTF-8 HTML from the solver immediately. This browser path supports GET and URL-encoded form POST; HEAD, JSON POST and multipart POST fail explicitly. FlareSolverr does not support arbitrary request headers and its DOM response has no reliable origin HTTP status. Automatic recovery only permits rendered fallback for an explicit `Accept: text/html` GET whose guarded retry is still challenged, excluding AJAX/JSON requests and browser `<pre>` documents. Real HTTP errors from the retry remain failures. Binary assets stay on the pinned direct transport with matching guest cookies and user agent.

The solver is a **trusted network boundary**: its browser resolves DNS and follows redirects and subresources internally. Initial/final URL checks cannot police those intermediate connections or pin the browser's DNS. Run the solver in an isolated network with suitable outbound restrictions if your threat model requires the direct broker's egress guarantees. The engine never exposes its token, environment or filesystem to the solver or plugin.

Native installation writes the shared solver URL into `novel.env`; `miaoyomi set-solver` updates all three consumers and restarts their services. With Compose, set `FLARESOLVERR_URL=http://solver:8191` and enable `--profile solver`, or use a reachable external endpoint. The bundled solver joins both the manga and novel networks.

## Compatibility and provenance

The vendored registry contains 278 scripts from official LNReader published commit **f324ba57cb89b8dd971008f010c787e46c7de41f**. Registry provenance, immutable script URLs and SHA-256 digests are in `vendor/registry.json`. Scripts are verified at startup; activation persists the published digest alongside enabled state. Updates require reviewing/replacing the pinned vendor snapshot; the runtime does not follow a mutable branch or download executable updates. Small source-specific compatibility shims are applied only after verification: Arcane follows its reviewed migration to NovelDex's public read API, Crimson Scrolls accepts both WordPress AJAX envelope shapes, and Webnovel labels its document requests as HTML so the guarded rendered-page fallback can handle a browser challenge. The original MIT license is retained at `vendor/LICENSE-LNReader`.

The common module map supplies `cheerio`, `htmlparser2`, `dayjs`, `@libs/fetch`, `@libs/storage`, `@libs/novelStatus`, `@libs/defaultCover`, `@libs/filterInputs`, `@libs/isAbsoluteUrl` and `@/types/constants`. The default-cover placeholder is empty so clients can display their own placeholder. Guest URL/URLSearchParams, text FormData, Headers, base64, promises and ordinary ECMAScript intrinsics are available. Response objects support `text`, `json`, `clone`, status, URL and headers.

270 sources pass the initial static host-capability scan. This is **not** a live-site availability claim. Unsupported modules (`@libs/aes`), browser storage/custom JavaScript, browser networking, text codecs and protobuf/file fetch helpers are shown explicitly. Binary FormData, Blob and binary guest responses also fail explicitly if invoked. Additional runtime evaluation errors remain visible on the source. Configured FlareSolverr can handle supported browser challenges; member login and unrestricted Node access remain unavailable.

Royal Road's normal public browse/detail/chapter flow and AO3 public guest-readable works were verified in the initial live check; works behind adult-consent or login pages fail explicitly. The pinned AO3 plugin declares a ratings filter but does not use it in its browse request; the live smoke therefore selects the first readable result, recording skipped consent pages. ScribbleHub returned a Cloudflare challenge on that direct-only check. Solver integration is covered by deterministic tests; live challenge success depends on the current site and solver browser.

## Verify

```sh
npm test          # deterministic fixtures, network, HTTP contract, isolation
npm run build     # guest bundle and syntax checks
npm run test:live # opt-in actual websites: Royal Road, AO3, ScribbleHub
npm run test:live -- royalroad archiveofourown
```

Fixture tests execute the actual pinned published scripts with hand-authored HTML and independently asserted novel/chapter IDs. Live tests are intentionally separate; remote availability, consent requirements and anti-bot responses can change. The smoke reads `FLARESOLVERR_URL` and treats unsolved challenges as failures when it is configured. Without a solver, ScribbleHub's known typed challenge is a recorded block; unexpected source failures fail the command.
