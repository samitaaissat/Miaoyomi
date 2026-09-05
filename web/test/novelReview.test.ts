import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBlob, setAccessToken } from '../lib/api';
import { latestNovelProgress } from '../lib/novels/progress';

test('EPUB downloads carry the session bearer and preserve binary bytes', async () => {
  const original = globalThis.fetch;
  setAccessToken('export-token');
  const bytes = new Uint8Array([0x50, 0x4b, 0, 0xff, 0x80]);
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer export-token');
    return new Response(bytes, { headers: { 'content-type': 'application/epub+zip' } });
  };
  try {
    const blob = await apiBlob('/api/novels/book/export.epub');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  } finally { globalThis.fetch = original; setAccessToken(null); }
});

test('continue reading prefers new offline progress and keeps completed chapters completed', () => {
  const remote = { chapterId: 'c1', position: 1, completed: true, updatedAt: 100, mutationId: 'server' };
  const local = { chapterId: 'c1', position: 0.4, completed: false, updatedAt: 200, mutationId: 'device' };
  assert.deepEqual(latestNovelProgress(local, remote), { ...local, completed: true });
  assert.deepEqual(latestNovelProgress({ ...local, chapterId: 'c2' }, remote), { ...local, chapterId: 'c2' });
});

test('an account-bound request cannot retry with the next accounts refreshed token', async () => {
  const { api, setCurrentUser } = await import('../lib/api');
  const original = globalThis.fetch;
  setCurrentUser('account-a');
  setAccessToken('token-a');
  const calls: string[] = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url) === '/auth/refresh') return Response.json({ accessToken: 'token-b' });
    setCurrentUser('account-b');
    return new Response('{}', { status: 401 });
  };
  try {
    await assert.rejects(api('/api/novels/book/progress', { method: 'PUT', json: {}, accountId: 'account-a' }), /account changed/i);
    assert.equal(calls.filter((url) => url.includes('/progress')).length, 1);
  } finally { globalThis.fetch = original; setAccessToken(null); setCurrentUser(null); }
});
