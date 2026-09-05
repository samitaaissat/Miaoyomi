# Private LNReader engine

Internal Fastify service for Miaoyomi. It executes **unmodified published LNReader v3 plugins in QuickJS**, with Cheerio, htmlparser2 and dayjs bundled into the guest. Each invocation runs in a worker with an independent hard deadline; the worker receives no environment variables. Guest code has no Node, filesystem, OS, environment or unrestricted module access. Network requests cross a JSON-only bridge to the guarded host broker.

## Run

Node 24 or later:

```sh
cd novel-engine
npm ci
npm run build
export NOVEL_ENGINE_TOKEN='replace-with-a-long-random-shared-token'
export NOVEL_ENGINE_STATE_DIR='./state'
npm start
```

The service listens on port **4100** (`PORT` overrides), bound to `HOST` (default `0.0.0.0`; use `127.0.0.1` for native local tests). Keep it on the private Compose network; the authenticated BFF is its public boundary. `NOVEL_ENGINE_TOKEN` must equal the BFF's engine token. All sources initially are disabled; activate them through the BFF admin UI or the private route:

```sh
curl -H "Authorization: Bearer $NOVEL_ENGINE_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' \
  http://localhost:4100/v1/sources/royalroad
```

`docker build --platform linux/amd64 -t miaoyomi-novel-engine:local novel-engine` from the repository root creates the Node 24 Alpine image. It runs as the `node` user. Mount only a writable configuration directory at `/state`, owned by uid/gid **1000:1000** (initialize/chown externally when a volume provider does not preserve image-directory ownership); use a read-only root filesystem, dropped capabilities, `no-new-privileges`, and container CPU/memory limits in Compose. There is no library or database mount. The existing reverse proxy should reach the BFF, not this service.

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

Failures use `{error,message}`: 400 invalid call, 401 invalid token, 404 unknown source, 409 disabled/unsupported capability, 502 source/network/challenge/busy errors, 504 deadline. `SITE_CHALLENGE` and `SOURCE_INTERSTITIAL` distinguish browser challenge/consent/login pages. HTTP failure cannot become a successful empty scrape even if a plugin catches fetch exceptions.

## Network and execution limits

- Only HTTP(S), standard ports and approved **exact origins** are accepted. All DNS answers must be public unicast; IPv4-mapped IPv6 is rejected. Each request connects to its validated DNS address, while preserving hostname/TLS verification. Every redirect revalidates origin and DNS.
- Five redirects, 12-second network deadline, 5 MiB decoded response, 64 KiB text request body, 32 fetches per invocation; hop-by-hop, host, authorization and user-supplied cookie headers are not forwarded.
- Cookies are in-memory, source-scoped public-guest jars with domain/path/secure matching; no account login API. Cookie count and size are bounded. Redirect cookies are retained.
- QuickJS: 64 MiB heap, 1 MiB stack, 20-second wall-clock limit. Worker: 128 MiB V8 heap and a host hard kill deadline. Two concurrent operations by default (`NOVEL_ENGINE_CONCURRENCY`); no unbounded queue. One invocation per source protects its transient KV snapshot.
- Plugin KV storage is source-scoped, in-memory only, limited to 256 KiB with a 15-minute reuse TTL. It is never written to configuration storage. A new isolate is created for each call, so other arbitrary plugin instance state does not survive calls.
- Plugin output: at most 8 MiB. Assets accept PNG, JPEG, GIF or WebP only when their signature matches the reported MIME type; AVIF, SVG and HTML are rejected. This matches the BFF archive path, which converts WebP to portable PNG inside the EPUB.
- Published `imageRequestInit` defaults (such as an image Referrer header) are loaded privately from the plugin and applied through the same request/header allowlist. They cannot override the destination host, provide Authorization or inject cookies; source-scoped cookie matching remains the broker's responsibility.

Source-site origins are allowed by default. The server adds Royal Road's reviewed cover CDN origins `https://www.royalroadcdn.com` and `https://royalroadcdn.com`. `NOVEL_ENGINE_ALLOWED_ORIGINS` may supply an administrator-reviewed JSON map of source IDs to additional exact origins; setting it replaces that default map. This never relaxes public-IP checks. A plugin needing an unapproved API/CDN produces an explicit `NETWORK_POLICY` failure.

## Compatibility and provenance

The vendored registry contains 278 scripts from official LNReader published commit **f324ba57cb89b8dd971008f010c787e46c7de41f**. Registry provenance, immutable script URLs and SHA-256 digests are in `vendor/registry.json`. Scripts are verified at startup; activation persists the digest alongside enabled state. Updates require reviewing/replacing the pinned vendor snapshot; the runtime does not follow a mutable branch or download executable updates. The original MIT license is retained at `vendor/LICENSE-LNReader`.

The common module map supplies `cheerio`, `htmlparser2`, `dayjs`, `@libs/fetch`, `@libs/storage`, `@libs/novelStatus`, `@libs/defaultCover`, `@libs/filterInputs`, `@libs/isAbsoluteUrl` and `@/types/constants`. The default-cover placeholder is empty so clients can display their own placeholder. Guest URL/URLSearchParams, text FormData, Headers, base64, promises and ordinary ECMAScript intrinsics are available. Response objects support `text`, `json`, `clone`, status, URL and headers.

249 sources pass the initial static host-capability scan. This is **not** a live-site availability claim. Unsupported modules (`@libs/aes`), browser storage/custom JavaScript, timers, browser networking, text codecs and protobuf/file fetch helpers are shown explicitly. Binary FormData, Blob and binary guest responses also fail explicitly if invoked. Additional runtime evaluation errors remain visible on the source. There is no challenge bypass, member login or unrestricted Node fallback.

Royal Road's normal public browse/detail/chapter flow is verified. AO3 public guest-readable works are verified; works behind adult-consent or login pages fail explicitly. The pinned AO3 plugin declares a ratings filter but does not use it in its browse request; the live smoke therefore selects the first readable result, recording skipped consent pages. ScribbleHub currently returns a Cloudflare challenge.

## Verify

```sh
npm test          # deterministic fixtures, network, HTTP contract, isolation
npm run build     # guest bundle and syntax checks
npm run test:live # opt-in actual websites: Royal Road, AO3, ScribbleHub
npm run test:live -- royalroad archiveofourown
```

Fixture tests execute the actual pinned published scripts with hand-authored HTML and independently asserted novel/chapter IDs. Live tests are intentionally separate; remote availability, consent requirements and anti-bot responses can change. The smoke treats ScribbleHub's known typed challenge as a recorded block; unexpected source failures fail the command.
