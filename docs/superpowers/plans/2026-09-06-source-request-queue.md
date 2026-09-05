# Source request queue implementation plan

**Goal:** Allow every selected manga source while bounding actual requests and keeping interactive work responsive.

**Architecture:** A shared in-memory scheduler wraps registered manga adapter operations and direct image fetches. It limits active work globally and per source, rotates sources fairly, favors interactive requests with aging, bounds pending work, and separates queue waiting from execution deadlines. The smaller browser and chapter gates remain separate resources. HTTP reads cancel abandoned work; long-running download jobs keep their existing lifecycle. This request queue does not persist abandoned HTTP requests or automatically retry mutations.

**Interfaces:** `RequestQueue.run(key, callback(signal), {signal,timeoutMs,priority})`, `snapshot()`, `close()`; `runSourceRequest`, `withSourceRequests`, `currentSourceRequest`, `sourceRequestSignal` share cancellation/context. Registered adapters return controllable promises so existing `withTimeout(p, ms)` applies to execution after dequeue. The underlying slot remains occupied until an uncooperative plugin actually finishes.

**Defaults:** Four active source operations, two per source, 128 pending overall, 32 pending per source, 30s maximum queue wait, 30s default execution budget, 5s aging threshold. Existing source/solver execution budgets override the default. Browser solves have a separate bounded queue. Chapter queue waits allow five minutes.

- [ ] Implement and verify the scheduler: bounded concurrency, fair dispatch, priority aging, overload, waiting/execution deadlines, cancellation, shutdown, and retention of occupied slots for uncooperative work.
- [ ] Wrap every registered adapter once; propagate cancellation into MangaDex/Suwayomi transport. Make timeouts queue-aware, connect HTTP-read cancellation, and expose safe queue statistics/errors.
- [ ] Remove source-count limits while preserving explicit disabled choices; prove more than 25 selected sources register.
- [ ] Bound browser and chapter queues and schedule image traffic without nested acquisition of the main queue; preserve downloader-specific 429 recovery.
- [ ] Feed multi-source searches lazily, return resumable partial results, preserve authorization on continuation, and keep shared listing fetches independent of any one caller.
- [ ] Run focused regressions, builds and review. Run database/live checks when the local runtime is available; record any unavailable checks without claiming them passed.
