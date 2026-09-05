import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';

const adapter = (search: (...args: any[]) => Promise<any>) => ({
  id: 'probe-source', name: 'Probe source', base: 'https://example.test',
  search,
  getSeries: async () => ({ title: 'A title' }),
  listChapters: async () => [{ sourceId: 'chapter-1', number: 1, title: 'One' }],
  getPageUrls: async () => ['https://example.test/1.jpg'],
}) as any;

test('smoke test defers local queue pressure without calling the source unhealthy', async () => {
  const [{ smokeTest }, { RequestQueueError }] = await Promise.all([
    import('../src/lib/sourceProbe'), import('../src/lib/requestQueue'),
  ]);
  let calls = 0;
  const result = await smokeTest(adapter(async () => {
    calls++;
    throw new RequestQueueError('QUEUE_FULL', 'locally busy');
  }));

  assert.equal(calls, 1, 'a local overload must not be retried as though the source returned no matches');
  assert.equal(result.ok, false);
  assert.equal(result.deferred, true);
  assert.equal(result.timedOut, undefined);
});

test('an execution deadline remains a real smoke timeout', async () => {
  const [{ smokeTest }, { RequestQueueError }] = await Promise.all([
    import('../src/lib/sourceProbe'), import('../src/lib/requestQueue'),
  ]);
  const result = await smokeTest(adapter(async () => {
    throw new RequestQueueError('REQUEST_TIMEOUT', 'source ran too long', 25);
  }));

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.deferred, undefined);
});

test('smoke deadline cancels the active adapter context and reports timeout', async () => {
  const [{ smokeTest }, { currentSourceRequest }] = await Promise.all([
    import('../src/lib/sourceProbe'), import('../src/lib/sourceRequests'),
  ]);
  const result = await smokeTest(adapter(async () => {
    const signal = currentSourceRequest().signal!;
    await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    return [];
  }), { timeoutMs: 15 });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test('bare probes run as background source requests', async () => {
  const [{ probeBase }, { currentSourceRequest }] = await Promise.all([
    import('../src/lib/sourceProbe'), import('../src/lib/sourceRequests'),
  ]);
  const original = globalThis.fetch;
  let priority: string | undefined;
  let cancelled = false;
  globalThis.fetch = (async () => {
    priority = currentSourceRequest().priority;
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 200, headers: { 'content-type': 'text/html' },
    });
  }) as typeof fetch;
  try {
    const result = await probeBase('https://example.test', 100);
    assert.equal(result.httpStatus, 200);
    assert.equal(priority, 'background');
    assert.equal(cancelled, true, 'the scheduler slot must cover disposal of the unused response body');
  } finally {
    globalThis.fetch = original;
  }
});
