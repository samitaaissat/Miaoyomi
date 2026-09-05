# Extensions (Mihon / Tachiyomi sources)

Uchiyomi ships **generic engines** that reach whole families of manga sites by URL. On top of that it can use
the **Mihon / Tachiyomi extension ecosystem** — the same extensions those apps use, roughly 1,400 of them.

You browse and install them from **Admin → Providers → Extensions**. There is nothing to set up first.

## Using it

1. Open **Admin → Providers**. The Extensions panel says `ready`.
2. **Add a repository** (once). Uchiyomi doesn't host extensions, so you point it at a repository you trust —
   the same URL you would paste into Mihon. Open **Manage** in the Extensions panel and add it.
3. **Search and click Add.** The extension installs, its sources switch on straight away, and it is
   searchable from Discover immediately. No second step, no restart.

Both Protobuf (`index.pb`) and JSON (`index.json`) repository indexes work with the bundled Suwayomi
v2.3.2243 engine. Miaoyomi registers repositories through Suwayomi's dedicated extension-store API, which
waits for the index to download and reports errors before refreshing the catalogue. If adding a repository
fails, check the reported error; changing between these two formats is normally unnecessary.

Adult extensions are hidden until you tap **18+**. Installed ones show **Remove**, and one with a newer
version shows **Update**.

## Automatic updates

Uchiyomi checks your repositories **every 6 hours** and installs new versions of the extensions you have
installed. You do not have to press anything.

The check is a task like any other: **Admin → Server → Tasks** shows when it last ran, what it did, and a
**Run now** button. You get a notification when extensions are updated, and a separate one when an update
fails — an extension whose download 404s stays on its old version, and that is worth knowing rather than
silently living with.

What it does on its own:

- **Re-reads your repositories, then updates.** This order is the whole point. The engine only recalculates
  "an update is available" when its repositories are re-read, so a check that skips that step compares
  against whatever was last fetched by hand and reliably finds nothing to do.
- **Waits for the chapter updater.** Replacing an extension while a library sweep is using it breaks that
  sweep's downloads, so updates wait for the next check instead. The panel says when it did.
- **Puts your repository list back.** The list is stored by Uchiyomi as well as by the engine, so deleting the
  engine's volume no longer silently un-configures the feature. If the volume is wiped, the check restores
  the repositories and reinstalls the extensions you had.
- **Tells you when an extension is abandoned.** An installed extension that no repository offers any more
  keeps working but will never update again. It is reported, never uninstalled — uninstalling would orphan
  every series routed through it.

What it will not do: install extensions you did not ask for, uninstall anything, or reinstall something you
removed yourself. Removing an extension in the engine's own interface is reported, not undone.

**To turn it off:** Admin → Server → Settings → *Update extensions automatically*. The check still runs and
still tells you what is waiting; it just does not install anything. The **Update all** button in the
Extensions panel remains the manual path, and it now refreshes the repositories first, so it no longer says
"everything is already up to date" against a stale catalogue.

The interval is *Extension check interval* in the same place. Six hours is chosen against how often the
repositories actually move (roughly every fifteen hours); there is nothing to gain from checking every hour.

## Why there is a second container

Those extensions are Kotlin, compiled to Android bytecode and shipped as APKs. They cannot run in Uchiyomi's
Node server, and there is no converter — "porting" them would mean rewriting hundreds by hand.

[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) is the one project that solved this. It converts an
extension's Android bytecode to JVM bytecode and supplies a fake Android runtime so the extension believes it
is on a phone, right down to a headless browser for the ones that need to get past Cloudflare.

So Uchiyomi runs Suwayomi as an **extension engine** and nothing else. It starts with the rest of the stack,
Uchiyomi configures itself to talk to it, and you never open it. Uchiyomi keeps owning your library, reader,
downloads, updates, users and UI; the engine only answers "search this", "list these chapters", "give me this
chapter's pages".

The cost is honest: it is a JVM and sits around 800 MB of RAM once running.

## How it behaves

- **Uchiyomi does the downloading.** Chapters land in your own library as CBZ files exactly like every other
  source, so there is one library, one updater and one set of files.
- **Cloudflare is the engine's problem, not ours.** These sources skip Uchiyomi's FlareSolverr entirely.
- **If the engine is down, Uchiyomi is fine.** It boots normally, the built-in engines keep working, the panel
  says it is unreachable, and extension-backed series simply do not update until it is back.
- **Series stay routed** by the source they came from, so the scheduled updater keeps pulling new chapters.

Two things worth knowing:

- A series added through an extension is routed using an id from the engine's own database. Wiping that
  database loses the routing for those series (they stay in your library; re-adding repairs it). Don't delete
  its volume. The scheduled check will put your repositories and your installed extensions back, but it
  cannot restore that routing — nothing outside the engine ever knew those ids.
- Installed sources stay visible in Providers. Cross-source work runs through a bounded request scheduler,
  so adding a multilingual extension does not hide later extensions or fire every request at once. Disabling
  a source in Providers remains an explicit operator choice and survives source reloads.

## Turning it off

Set `SUWAYOMI_URL=` (empty) in `.env` and restart the BFF; the panel disappears and nothing else changes. To
reclaim the RAM as well, `docker compose stop uchiyomi-suwayomi` (`yomi-suwayomi` in the development stack).

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `SUWAYOMI_URL` | the bundled engine | Where the extension engine is. Empty turns the feature off. |
| `SUWAYOMI_USERNAME` / `SUWAYOMI_PASSWORD` | empty | Only if your engine has authentication enabled. |
| `SOURCE_REQUEST_CONCURRENCY` | `4` | Maximum active manga adapter operations and image fetches, shared by browsing and downloads. |
| `SOURCE_REQUEST_PER_SOURCE` | `2` | Maximum active operations for one source. |
| `SOURCE_REQUEST_QUEUE_LIMIT` / `SOURCE_REQUEST_QUEUE_PER_SOURCE` | `128` / `32` | Maximum waiting operations overall and per source. |
| `SOURCE_REQUEST_QUEUE_WAIT_MS` | `30000` | Maximum time waiting for a worker. |
| `SOURCE_REQUEST_TIMEOUT_MS` | `30000` | Default execution deadline after acquiring a worker; source-specific deadlines take precedence. |
| `SOURCE_LATEST_TIMEOUT_MS` | `8000` | Execution deadline for a source's Discover listing, excluding queue wait. |
| `SOLVER_CONCURRENCY` / `SOLVER_QUEUE_LIMIT` | `2` / `64` | Active and waiting legacy manga browser solves. Novel solves use separate `NOVEL_SOLVER_*` settings. |
| `SOLVER_QUEUE_TIMEOUT_MS` / `SOLVER_REQUEST_TIMEOUT_MS` | `30000` / `95000` | Waiting and execution deadlines for the legacy browser queue. |

The update check's own settings live in **Admin → Server → Settings**, not here: *Update extensions
automatically* (on by default) and *Extension check interval* (6 hours).
There is no enabled-source count limit. `SUWAYOMI_MAX_SOURCES` is obsolete and ignored. Sources previously
disabled remain disabled until you enable them in Providers. The scheduler rotates eligible sources and
gives interactive requests priority; waiting background work ages into priority after five seconds. Closing
or replacing an HTTP read cancels its waiting work and aborts supported transports. A plugin that ignores
cancellation keeps its occupied worker until it finishes, preventing a timeout from exceeding concurrency.
Queue overload and expiry return retryable errors without recording a source-health failure. Admin →
Providers shows the active and waiting manga request counts.

Large cross-source searches use four workers and a 45-second page budget. Results arrive with a
continuation when more sources remain; **Search remaining sources** keeps the existing cards and checks
the remaining providers. Sources that failed are reported separately from ones waiting for capacity.
Search continuations expire after 15 minutes or an app restart; submit the search again to refresh them.

The queues are in memory: a restart cancels them. They do not persist HTTP requests or automatically replay
failed operations. Downloads retain their existing retry behavior for HTTP 429 responses. Their chapter
gate also bounds waiting work (32 per source, 256 overall), with a five-minute waiting budget.

**Adult sources.** Extensions declare whether they are adult, and Uchiyomi records that per source. A member
whose age limit is set below 18 cannot reach one: it is left out of their source list entirely, and the
server refuses it by id rather than relying on the app to hide it. Admins and members with no age limit are
unaffected. Sources with no such declaration — the built-in engines, source packs, custom sites — are treated
as not adult, the same way an unrated series stays visible instead of vanishing the moment a limit is set.

You can point `SUWAYOMI_URL` at a Suwayomi you already run instead of the bundled one; Uchiyomi doesn't care
whose it is.

The image is pinned rather than tracking `:stable`, because `:stable` is older than the extension API today's
repository indexes require and would show an empty catalogue.

## Where the line is

Uchiyomi's code contains **no scraper, no site name, and no repository URL**. The catalogue you browse comes
from repositories *you* add, and the engine does the fetching and installing. Uchiyomi never hosts or
redistributes an extension, and ships no default repository — so nothing is fetched from anywhere until you
choose a source for it.

What you point it at, and whether that is lawful where you live, is your call and your responsibility.
