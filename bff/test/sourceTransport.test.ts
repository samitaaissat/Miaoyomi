import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET ||= 'source-transport-test-secret';
process.env.SUWAYOMI_URL ||= 'http://suwayomi.test:4567';

const waitForAbort = (init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
  const signal = init?.signal;
  if (!signal) return reject(new Error('transport did not receive a signal'));
  if (signal.aborted) return reject(signal.reason);
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('Suwayomi transport combines its timeout with the current source-request cancellation', async () => {
  const { withSourceRequests } = await import('../src/lib/sourceRequests');
  const { gql } = await import('../src/lib/sources/suwayomi/client');
  let transportSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    transportSignal = init?.signal as AbortSignal;
    return waitForAbort(init);
  }) as typeof fetch;

  const caller = new AbortController();
  const request = withSourceRequests({ signal: caller.signal }, () => gql('{ aboutServer { name } }', {}, 5000));
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort(new Error('client disconnected'));

  await assert.rejects(request, /client disconnected/);
  assert.equal(transportSignal?.aborted, true, 'the active HTTP request was aborted');
});

test('MangaDex transport observes the current source-request cancellation', async () => {
  const { withSourceRequests } = await import('../src/lib/sourceRequests');
  const { mangadex } = await import('../src/lib/sources/mangadex');
  let transportSignal: AbortSignal | null = null;
  globalThis.fetch = (async (_url: any, init?: RequestInit) => {
    transportSignal = init?.signal as AbortSignal;
    return waitForAbort(init);
  }) as typeof fetch;

  const caller = new AbortController();
  const request = withSourceRequests({ signal: caller.signal }, () => mangadex.search('cancel me'));
  await new Promise((resolve) => setImmediate(resolve));
  caller.abort(new Error('client disconnected'));

  await assert.rejects(request, /client disconnected/);
  assert.equal(transportSignal?.aborted, true, 'the active HTTP request was aborted');
});
