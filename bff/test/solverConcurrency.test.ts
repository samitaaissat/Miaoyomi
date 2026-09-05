// How many Cloudflare solves we ask for at once.
//
// FlareSolverr drives real Chrome. The fill scan searches every configured source in parallel, which put a
// dozen challenges on it simultaneously; live it logged "Task queue depth is 4" and then
// "Error starting Chrome: Service /app/chromedriver unexpectedly exited". A crashed solve surfaces to the
// caller as the SITE refusing us, so our own fan-out was manufacturing source failures.
process.env.SOLVER_CONCURRENCY = '3';
process.env.SOLVER_QUEUE_LIMIT = '16';
import test from 'node:test';
import assert from 'node:assert/strict';

const load = () => import('../src/lib/sources/flaresolverr');

test('never more than SOLVER_CONCURRENCY solves are in flight', async () => {
  const { cfGet } = await load();
  let now = 0, peak = 0;
  globalThis.fetch = (async () => {
    now++; peak = Math.max(peak, now);
    await new Promise((r) => setTimeout(r, 20));
    now--;
    return new Response(
      JSON.stringify({ status: 'ok', solution: { url: 'https://e.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await Promise.all(Array.from({ length: 12 }, (_, i) => cfGet(`https://e.test/${i}`)));

  assert.equal(peak <= 3, true, `peak concurrent solves was ${peak}, cap is 3`);
  assert.ok(peak > 1, 'and it is a cap, not accidental serialisation');
});

/** A solve that throws must still free its slot, or the queue deadlocks after SOLVER_CONCURRENCY failures. */
test('a failed solve releases its slot', async () => {
  const { cfGet } = await load();
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('solver down'); }) as typeof fetch;

  for (let i = 0; i < 5; i++) await cfGet(`https://e.test/fail${i}`).catch(() => {});
  assert.equal(calls, 5, 'every attempt got a slot; a leaked slot would hang here instead');

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ status: 'ok', solution: { url: 'https://e.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  assert.match(await cfGet('https://e.test/after'), /ok/, 'and the pool still works afterwards');
});

test('the solver backlog is bounded', async () => {
  const { cfGet } = await load();
  let started = 0;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    started++;
    await blocker;
    return new Response(
      JSON.stringify({ status: 'ok', solution: { url: 'https://full.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const admitted = Array.from({ length: 19 }, (_, i) => cfGet(`https://full.test/${i}`));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started, 3, 'only the active solver slots reached the transport');
  await assert.rejects(cfGet('https://full.test/rejected'), /queue/i);
  release();
  await Promise.all(admitted);
});

test('cancelling a queued solve removes it before transport', async () => {
  const { cfGet } = await load();
  let started = 0;
  let release!: () => void;
  const blocker = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async () => {
    started++;
    await blocker;
    return new Response(
      JSON.stringify({ status: 'ok', solution: { url: 'https://cancel.test/', status: 200, response: '<html>ok</html>', cookies: [], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const active = Array.from({ length: 3 }, (_, i) => cfGet(`https://cancel.test/active-${i}`));
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  const queued = cfGet('https://cancel.test/queued', controller.signal);
  controller.abort(new Error('caller left'));
  await assert.rejects(queued);
  assert.equal(started, 3, 'the cancelled queue entry must not consume a browser request');
  release();
  await Promise.all(active);
});

test('an aborted image-session solve is neither retried nor cached as unsolvable', async () => {
  const { cfSession } = await load();
  let calls = 0;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    calls++;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }
    return new Response(
      JSON.stringify({ status: 'ok', solution: { url: 'https://image-cancel.test/', status: 200, response: '<html>ok</html>', cookies: [{ name: 'cf', value: 'yes' }], userAgent: 'UA' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  await assert.rejects(cfSession('https://image-cancel.test/cover.jpg', AbortSignal.timeout(10)));
  assert.equal(calls, 1, 'a cancelled root solve must not start the URL fallback');
  const session = await cfSession('https://image-cancel.test/cover.jpg');
  assert.equal(calls, 2, 'caller cancellation must not poison the origin cooldown');
  assert.equal(session.cookie, 'cf=yes');
});

test('shutdown aborts standalone solver work and rejects its caller', async () => {
  const { cfGet, closeSolverQueue } = await load();
  let transportSignal: AbortSignal | undefined;
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    transportSignal = init?.signal as AbortSignal;
    started();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;

  const request = cfGet('https://shutdown.test/page');
  await began;
  closeSolverQueue();
  await assert.rejects(request, (error: any) => error.code === 'QUEUE_CLOSED');
  assert.equal(transportSignal?.aborted, true, 'shutdown reaches the active solver transport');
});
