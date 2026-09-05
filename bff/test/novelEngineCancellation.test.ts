import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'novel-engine-cancellation-test';

test('cancelling a browser read aborts its request to the novel engine', async () => {
  const { createNovelEngine } = await import('../src/lib/novels/engine');
  const { withSourceRequests } = await import('../src/lib/sourceRequests');
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let seen: AbortSignal | undefined;
  globalThis.fetch = (async (_url, init) => {
    seen = init?.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      seen!.addEventListener('abort', () => reject(seen!.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    const pending = withSourceRequests({ signal: caller.signal }, () => createNovelEngine('http://engine.test', 'fixture').invoke('fixture', 'search', ['term']));
    const rejected = assert.rejects(pending, { code: 'engine_unavailable' });
    assert.equal(seen?.aborted, false);
    caller.abort();
    await rejected;
    assert.equal(seen?.aborted, true);
  } finally { globalThis.fetch = originalFetch; }
});
