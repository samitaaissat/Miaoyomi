import test from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
process.env.DATABASE_URL ||= 'postgres://test:test@127.0.0.1:1/test';

test('one latest waiter cancelling does not cancel the shared fetch for another waiter', async () => {
  const [{ latestPage, clearLatestCache }, loader, requests] = await Promise.all([
    import('../src/routes/sources'),
    import('../src/lib/sources/loader'),
    import('../src/lib/sourceRequests'),
  ]);
  loader.reloadSources('/definitely-not-a-source-directory');
  clearLatestCache();

  let calls = 0;
  let finish!: () => void;
  const release = new Promise<void>((resolve) => { finish = resolve; });
  loader.registerAdapter({
    id: 'shared-latest', name: 'Shared latest',
    async search() { return []; },
    async getSeries() { return null; },
    async listChapters() { return []; },
    async getPageUrls() { return []; },
    async latest() {
      calls++;
      await release;
      return [{ sourceId: 'one', source: 'shared-latest', title: 'One' }];
    },
  });
  const src = loader.getSource('shared-latest')!;
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = requests.withSourceRequests({ signal: firstController.signal }, () => latestPage(src, 1));
  const second = requests.withSourceRequests({ signal: secondController.signal }, () => latestPage(src, 1));

  firstController.abort();
  await assert.rejects(first, (error: any) => error?.code === 'CANCELLED');
  finish();
  assert.deepEqual(await second, [{ sourceId: 'one', source: 'shared-latest', title: 'One' }]);
  assert.equal(calls, 1, 'both waiters must share one upstream listing request');
});
