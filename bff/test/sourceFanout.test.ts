import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';

const load = () => import('../src/routes/sources');

const aborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('source fan-out starts only four workers and returns the unstarted tail at its wall deadline', async () => {
  const { boundedSourceFanout } = await load();
  let active = 0;
  let peak = 0;
  const started: number[] = [];

  const result = await boundedSourceFanout(
    Array.from({ length: 12 }, (_, i) => i),
    async (item, signal) => {
      started.push(item);
      peak = Math.max(peak, ++active);
      try { return await aborted(signal); }
      finally { active--; }
    },
    { concurrency: 4, budgetMs: 20 },
  );

  assert.equal(peak, 4);
  assert.deepEqual(started, [0, 1, 2, 3], 'the rest must stay outside the shared request queue');
  assert.deepEqual(result.values, []);
  assert.deepEqual(result.notTried, Array.from({ length: 12 }, (_, i) => i),
    'deadline-cancelled work must remain continuable along with work that never started');
});

test('source fan-out preserves successful input order and does not retry real source failures', async () => {
  const { boundedSourceFanout } = await load();
  const result = await boundedSourceFanout(
    [0, 1, 2, 3],
    async (item) => {
      if (item === 1) throw new Error('site refused');
      await new Promise((resolve) => setTimeout(resolve, item === 0 ? 8 : 1));
      return item * 10;
    },
    { concurrency: 2, budgetMs: 500 },
  );

  assert.deepEqual(result.values, [0, 20, 30]);
  assert.deepEqual(result.failed, [1]);
  assert.deepEqual(result.notTried, []);
});

test('local queue overload is continuable and is not presented as a source failure', async () => {
  const [{ boundedSourceFanout }, { RequestQueueError }] = await Promise.all([
    load(), import('../src/lib/requestQueue'),
  ]);
  const result = await boundedSourceFanout(
    [0, 1, 2],
    async (item) => {
      if (item === 1) throw new RequestQueueError('QUEUE_FULL', 'busy here');
      return item;
    },
    { concurrency: 2, budgetMs: 500 },
  );

  assert.deepEqual(result.values, [0, 2]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.notTried, [1]);
});

test('a caller cancellation stops feeding fan-out work and reports no continuation', async () => {
  const { boundedSourceFanout } = await load();
  const controller = new AbortController();
  const started: number[] = [];
  const resultPromise = boundedSourceFanout(
    [0, 1, 2, 3],
    async (item, signal) => {
      started.push(item);
      return aborted(signal);
    },
    { concurrency: 2, budgetMs: 500, signal: controller.signal },
  );
  controller.abort(new Error('client left'));
  const result = await resultPromise;

  assert.ok(started.length <= 2);
  assert.equal(result.cancelled, true);
  assert.deepEqual(result.notTried, [], 'a disconnected caller cannot continue this response');
});

test('search cursors stay short while preserving hundreds of remaining source identities', async () => {
  const { encodeSearchCursor, decodeSearchCursor, clearSearchCursors } = await load();
  clearSearchCursors();
  const remaining = Array.from({ length: 500 }, (_, index) => `eu.kanade.tachiyomi.extension.en.provider-${index}`);
  const cursor = encodeSearchCursor('Dragon Tea', remaining);

  assert.ok(cursor.length < 64, `opaque cursor should be safe in a GET URL, got ${cursor.length} characters`);
  assert.deepEqual(decodeSearchCursor(cursor, 'Dragon Tea'), remaining);
  assert.equal(decodeSearchCursor(cursor, 'another title'), null);
  assert.equal(decodeSearchCursor('not-a-cursor', 'Dragon Tea'), null);
});

test('search cursor storage is bounded and expires stale continuations', async () => {
  const { encodeSearchCursor, decodeSearchCursor, clearSearchCursors } = await load();
  clearSearchCursors();
  const oldest = encodeSearchCursor('first', ['a']);
  let newest = '';
  for (let index = 0; index < 128; index++) newest = encodeSearchCursor(`query-${index}`, [`source-${index}`]);
  assert.equal(decodeSearchCursor(oldest, 'first'), null, 'the oldest entry should be evicted at the 128-entry bound');
  assert.deepEqual(decodeSearchCursor(newest, 'query-127'), ['source-127']);

  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    clearSearchCursors();
    const expiring = encodeSearchCursor('short lived', ['source-a']);
    now += 15 * 60_000 + 1;
    assert.equal(decodeSearchCursor(expiring, 'short lived'), null);
  } finally {
    Date.now = realNow;
    clearSearchCursors();
  }
});

test('the updater distinguishes local queue pressure from a source failure', async () => {
  const [{ sourceListFailureOutcome }, { RequestQueueError }] = await Promise.all([
    import('../src/lib/updater'), import('../src/lib/requestQueue'),
  ]);
  assert.equal(sourceListFailureOutcome(new RequestQueueError('QUEUE_TIMEOUT', 'busy')), 'deferred');
  assert.equal(sourceListFailureOutcome(new RequestQueueError('QUEUE_FULL', 'full')), 'deferred');
  assert.equal(sourceListFailureOutcome(new RequestQueueError('REQUEST_TIMEOUT', 'slow')), 'source_error');
  assert.equal(sourceListFailureOutcome(new Error('site refused')), 'source_error');
});
