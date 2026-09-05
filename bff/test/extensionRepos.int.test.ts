// Real admin routes and database, with Suwayomi's network boundary controlled.
// The deprecated settings mutation can acknowledge a write without registering a store.
// Adding must use the awaited store mutation, and a failed download must reach the admin.
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET ||= 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR ||= '/tmp/miaoyomi-extension-tests';
  process.env.SUWAYOMI_URL = 'http://suwayomi.test:4567';
}

test('extension repository admin routes', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { migrate } = await import('../src/lib/migrate');
  const { q, pool } = await import('../src/lib/db');
  const adminRoutes = (await import('../src/routes/admin')).default;
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  await migrate();
  const user = (await q<{ id: string }>(
    `INSERT INTO users (username, password_hash, role, auth_kind)
     VALUES ('extension-repos-test','x','admin','password') RETURNING id`,
  ))[0].id;
  const app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(adminRoutes);
  await app.ready();
  await q(`UPDATE server_settings SET extension_repos = '[]' WHERE id = 1`);
  const headers = { authorization: `Bearer ${app.jwt.sign({ sub: user, role: 'admin' })}` };
  const savedRepos = async () => (await q<{ extension_repos: string[] }>(
    'SELECT extension_repos FROM server_settings WHERE id = 1',
  ))[0].extension_repos;
  let stores: string[] = [];
  let catalog: Array<{ pkgName: string; name: string; repo: string }> = [];
  let downloadError: string | undefined;
  const queries: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(String(url), 'http://suwayomi.test:4567/api/graphql');
    const { query, variables } = JSON.parse(init.body as string);
    queries.push(query);
    let data: unknown;
    if (/addExtensionStore\(/.test(query)) {
      if (downloadError) return Response.json({ errors: [{ message: downloadError }] });
      const input = Object.values(variables).find((v) => typeof v === 'string') as string;
      const canonical = input.replace('/repo.json', '/index.pb');
      stores = [...new Set([...stores, canonical])];
      data = { addExtensionStore: { extensionStore: { indexUrl: canonical, name: 'Test store' } } };
    } else if (/removeExtensionStore\(/.test(query)) {
      const input = Object.values(variables).find((v) => typeof v === 'string') as string;
      stores = stores.filter((s) => s !== input);
      data = { removeExtensionStore: { extensionStore: { indexUrl: input } } };
    } else if (/setSettings/.test(query)) {
      // Acknowledged, but asynchronous synchronization never registered the store.
      data = { setSettings: { settings: { extensionRepos: variables.r } } };
    } else if (/extensionRepos/.test(query)) {
      data = { settings: { extensionRepos: stores } };
    } else if (/extensionStores/.test(query)) {
      data = { extensionStores: { nodes: stores.map((indexUrl) => ({ indexUrl })) } };
    } else if (/fetchExtensions/.test(query)) {
      catalog = stores.map((repo) => ({ pkgName: 'test.extension', name: 'Test extension', repo }));
      data = { fetchExtensions: { extensions: catalog } };
    } else {
      assert.match(query, /extensions/);
      data = { extensions: { nodes: catalog } };
    }
    return Response.json({ data });
  });
  const add = (url: string) => app.inject({ method: 'POST', url: '/api/admin/extensions/repos', headers, payload: { url } });

  try {
    await t.test('adding registers the store before refreshing the catalogue', async () => {
      const res = await add('https://example.org/index.pb');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().total, 1, 'acknowledging a settings write did not load the catalogue');
      assert.deepEqual(stores, ['https://example.org/index.pb']);
      assert.deepEqual(await savedRepos(), stores, 'a wiped engine needs the repository saved in Miaoyomi too');
      assert.ok(!queries.some((query) => /setSettings/.test(query)), 'must not rely on deprecated asynchronous settings');
      const listed = await app.inject({ method: 'GET', url: '/api/admin/extensions/repos', headers });
      assert.deepEqual(listed.json().content, stores);
    });

    await t.test('download errors reach the admin and preserve existing stores', async () => {
      stores = ['https://example.org/existing/index.pb'];
      const prior = [...stores];
      await q('UPDATE server_settings SET extension_repos = $1 WHERE id = 1', [JSON.stringify(prior)]);
      downloadError = 'HTTP error 403';
      const res = await add('https://example.org/refused/index.pb');
      assert.equal(res.statusCode, 502, res.body);
      assert.match(res.json().message, /403/);
      assert.deepEqual(stores, prior);
      assert.deepEqual(await savedRepos(), prior);
      downloadError = undefined;
    });

    await t.test('the canonical URL returned by Suwayomi is reported and removable', async () => {
      stores = [];
      catalog = [];
      const res = await add('https://example.org/repo.json');
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().url, 'https://example.org/index.pb');
      assert.equal(res.json().corrected, true);
      assert.deepEqual(stores, ['https://example.org/index.pb']);
      assert.deepEqual(await savedRepos(), stores, 'backup must use the canonical index URL');
      const removed = await app.inject({
        method: 'DELETE', url: '/api/admin/extensions/repos', headers,
        payload: { url: res.json().url },
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.deepEqual(stores, []);
      assert.deepEqual(await savedRepos(), [], 'the scheduled monitor must not restore a removed repository');
    });
  } finally {
    await app.close();
    await q('DELETE FROM users WHERE id = $1', [user]);
    await q(`UPDATE server_settings SET extension_repos = '[]' WHERE id = 1`);
    await pool.end();
  }
});
