import test from 'node:test';
import assert from 'node:assert/strict';

// The native installer explicitly writes an empty URL when the integration is disabled.
process.env.FLARESOLVERR_URL = '';
const load = () => import('../src/lib/sources/flaresolverr');

test('an explicitly disabled solver rejects page requests without network access', async (t) => {
  const { cfGet, cfPost } = await load();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Unexpected network access');
  });

  await assert.rejects(cfGet('https://example.test/chapter'), /flaresolverr.*disabled/i);
  await assert.rejects(cfPost('https://example.test/search', 'q=title'), /flaresolverr.*disabled/i);
  assert.equal(requests, 0);
});

test('the health probe identifies a disabled solver without contacting a default host', async (t) => {
  const { solverPing, solverUrl } = await load();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Unexpected network access');
  });

  const health = await solverPing();
  assert.equal(health.ok, false);
  assert.match(health.error || '', /disabled/i);
  assert.equal(solverUrl(), '');
  assert.equal(requests, 0);
});

test('image downloads retain their direct-fetch fallback when the solver is disabled', async (t) => {
  const { cfSession } = await load();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Unexpected network access');
  });

  assert.deepEqual(await cfSession('https://images.example.test/page.jpg'), {
    cookie: '', userAgent: 'Mozilla/5.0',
  });
  assert.equal(requests, 0);
});
