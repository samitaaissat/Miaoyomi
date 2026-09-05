// The download gate. Without it, importing a few hundred titles starts a few hundred simultaneous download
// loops against the same sites — which reads as an attack and gets the server blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withGate, gateDepth } from '../src/lib/gate';
import { isRequestQueueError } from '../src/lib/requestQueue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('never exceeds the configured concurrency for a key', async () => {
  let inFlight = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 12 }, () =>
      withGate('site-a', async () => {
        peak = Math.max(peak, ++inFlight);
        await sleep(10);
        inFlight--;
      }, { concurrency: 3 }),
    ),
  );
  assert.equal(peak, 3, `expected at most 3 concurrent, saw ${peak}`);
  assert.equal(inFlight, 0);
});

test('keys are independent, so a slow site cannot starve a fast one', async () => {
  let aDone = false;
  const slow = withGate('slow-site', async () => { await sleep(80); aDone = true; }, { concurrency: 1 });
  await withGate('fast-site', async () => {}, { concurrency: 1 });
  assert.equal(aDone, false, 'the fast site finished without waiting on the slow one');
  await slow;
});

test('enforces a minimum gap between operations on the same key', async () => {
  const started: number[] = [];
  await Promise.all(
    Array.from({ length: 3 }, () => withGate('paced', async () => { started.push(Date.now()); }, { concurrency: 1, minGapMs: 40 })),
  );
  started.sort((a, b) => a - b);
  assert.ok(started[1] - started[0] >= 35, `gap 1 was ${started[1] - started[0]}ms`);
  assert.ok(started[2] - started[1] >= 35, `gap 2 was ${started[2] - started[1]}ms`);
});

test('releases the slot when the operation throws', async () => {
  await assert.rejects(withGate('boom', async () => { throw new Error('nope'); }, { concurrency: 1 }));
  // if the slot leaked, this would hang forever rather than resolve
  await withGate('boom', async () => {}, { concurrency: 1 });
  assert.deepEqual(gateDepth('boom'), { active: 0, queued: 0 }, 'lane is cleaned up');
});

test('queued work still runs after a failure ahead of it', async () => {
  const ran: string[] = [];
  const failing = withGate('mixed', async () => { await sleep(5); throw new Error('x'); }, { concurrency: 1 }).catch(() => ran.push('failed'));
  const following = withGate('mixed', async () => { ran.push('ran'); }, { concurrency: 1 });
  await Promise.all([failing, following]);
  assert.ok(ran.includes('ran'), 'work queued behind a failure must still execute');
});

test('rejects work beyond the per-key pending bound', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const active = withGate('bounded-key', () => hold, { concurrency: 1, maxPendingPerKey: 1 });
  const queued = withGate('bounded-key', async () => {}, { concurrency: 1, maxPendingPerKey: 1 });
  await sleep(5);

  await assert.rejects(
    withGate('bounded-key', async () => {}, { concurrency: 1, maxPendingPerKey: 1 }),
    (e: any) => isRequestQueueError(e) && e.code === 'QUEUE_FULL' && e.statusCode === 503,
  );
  release();
  await Promise.all([active, queued]);
});

test('bounds pending work across many different keys', async () => {
  const releases: Array<() => void> = [];
  const active = ['global-a', 'global-b', 'global-c'].map((key) => withGate(key, () =>
    new Promise<void>((resolve) => releases.push(resolve)), { concurrency: 1, maxPendingTotal: 2 }));
  await sleep(5);
  const waiting = [
    withGate('global-a', async () => {}, { concurrency: 1, maxPendingTotal: 2 }),
    withGate('global-b', async () => {}, { concurrency: 1, maxPendingTotal: 2 }),
  ];
  await sleep(5);

  await assert.rejects(
    withGate('global-c', async () => {}, { concurrency: 1, maxPendingTotal: 2 }),
    (e: any) => isRequestQueueError(e) && e.code === 'QUEUE_FULL' && e.statusCode === 503,
  );
  releases.forEach((release) => release());
  await Promise.all([...active, ...waiting]);
});

test('an aborted waiter is removed and never runs', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const active = withGate('cancelled', () => hold, { concurrency: 1 });
  const controller = new AbortController();
  let ran = false;
  const waiting = withGate('cancelled', async () => { ran = true; }, {
    concurrency: 1, signal: controller.signal,
  });
  await sleep(5);
  assert.deepEqual(gateDepth('cancelled'), { active: 1, queued: 1 });
  controller.abort();

  await assert.rejects(waiting, (e: any) => isRequestQueueError(e) && e.code === 'CANCELLED');
  assert.deepEqual(gateDepth('cancelled'), { active: 1, queued: 0 });
  assert.equal(ran, false);
  release();
  await active;
});

test('a waiter times out and leaves no queued entry', async () => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const active = withGate('deadline', () => hold, { concurrency: 1 });

  await assert.rejects(
    withGate('deadline', async () => {}, { concurrency: 1, maxWaitMs: 15 }),
    (e: any) => isRequestQueueError(e) && e.code === 'QUEUE_TIMEOUT' && e.statusCode === 503,
  );
  assert.deepEqual(gateDepth('deadline'), { active: 1, queued: 0 });
  release();
  await active;
});

test('minimum spacing survives an idle moment between sequential operations', async () => {
  const started: number[] = [];
  await withGate('sequential-pacing', async () => { started.push(Date.now()); }, { minGapMs: 35 });
  await withGate('sequential-pacing', async () => { started.push(Date.now()); }, { minGapMs: 35 });
  assert.ok(started[1] - started[0] >= 30, `sequential gap was ${started[1] - started[0]}ms`);
});

test('the wait deadline includes politeness spacing before the operation starts', async () => {
  await withGate('pacing-deadline', async () => {}, { minGapMs: 50 });
  let ran = false;
  await assert.rejects(
    withGate('pacing-deadline', async () => { ran = true; }, { minGapMs: 50, maxWaitMs: 10 }),
    (e: any) => isRequestQueueError(e) && e.code === 'QUEUE_TIMEOUT' && e.statusCode === 503,
  );
  assert.equal(ran, false);
});
