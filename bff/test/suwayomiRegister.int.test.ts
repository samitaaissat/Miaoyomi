// Which extension sources actually get registered.
//
// This is the rule that decides whether the feature is usable at all rather than a nicety: every selected
// source must remain available. Outbound work is bounded by the request scheduler rather
// than by hiding adapters, while Providers' disabled state remains an operator choice across reloads.
//
// Skipped automatically unless TEST_DATABASE_URL is set (CI provides a throwaway Postgres service).
import test from 'node:test';
import assert from 'node:assert/strict';

const DSN = process.env.TEST_DATABASE_URL;
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.SUWAYOMI_URL = process.env.SUWAYOMI_URL || 'http://suwayomi.test:4567';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = process.env.CONFIG_DIR || '/tmp/uchiyomi-test-config';
}

const remote = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: String(i), name: `Source ${i}`, lang: 'en', supportsLatest: false }));

async function setup() {
  const { migrate } = await import('../src/lib/migrate');
  const { q } = await import('../src/lib/db');
  const reg = await import('../src/lib/sources/suwayomi/register');
  const loader = await import('../src/lib/sources/loader');
  await migrate();
  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
  return { q, reg, loader };
}

test('extension source registration', { skip: DSN ? false : 'set TEST_DATABASE_URL to run' }, async (t) => {
  const { q, reg, loader } = await setup();
  const reset = () => loader.reloadSources('/nonexistent-so-this-just-clears-the-registry');

  await t.test('a source Suwayomi offers is remembered but NOT registered until switched on', async () => {
    reset();
    const r = await reg.loadSuwayomiSources(async () => remote(3));
    assert.equal(r.available, 3);
    assert.equal(r.registered, 0, 'sources must be opt-in, not registered on sight');
    const rows = await q<{ source_id: string; enabled: boolean }>('SELECT source_id, enabled FROM suwayomi_sources');
    assert.equal(rows.length, 3, 'they should still be remembered so the admin list can render');
    assert.ok(rows.every((x) => !x.enabled));
    assert.equal(loader.listSources().length, 0);
  });

  await t.test('only the enabled ones register', async () => {
    reset();
    await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id IN ('0','2')`);
    const r = await reg.loadSuwayomiSources(async () => remote(3));
    assert.equal(r.registered, 2);
    assert.deepEqual(loader.sourceIds().sort(), ['sw:0', 'sw:2']);
  });

  await t.test('re-listing keeps names fresh without turning anything on', async () => {
    reset();
    await reg.loadSuwayomiSources(async () => [{ id: '0', name: 'Renamed Source', lang: 'fr' }]);
    const row = await q<{ name: string; lang: string; enabled: boolean }>(
      `SELECT name, lang, enabled FROM suwayomi_sources WHERE source_id = '0'`,
    );
    assert.equal(row[0].name, 'Renamed Source');
    assert.equal(row[0].lang, 'fr');
    assert.equal(row[0].enabled, true, 'an existing choice must survive a refresh');
  });

  await t.test('the adult flag survives a re-register rather than being reset', async () => {
    // `isNsfw` was selected in SOURCES_Q and then discarded at every step: no column, nothing on the
    // adapter, nothing in the API. It is now the ONLY signal keeping an age-capped account out of an adult
    // source, so an extension that turns adult in a later version must not keep an old `false`, and one that
    // is already adult must not be un-flagged by the next refresh.
    reset();
    await q('DELETE FROM suwayomi_sources');
    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en' }]);
    assert.equal((await q<{ nsfw: boolean }>(`SELECT nsfw FROM suwayomi_sources WHERE source_id = '9'`))[0].nsfw, false);

    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en', isNsfw: true }]);
    assert.equal(
      (await q<{ nsfw: boolean }>(`SELECT nsfw FROM suwayomi_sources WHERE source_id = '9'`))[0].nsfw, true,
      'a source that became adult stayed marked clean',
    );

    await q(`UPDATE suwayomi_sources SET enabled = true WHERE source_id = '9'`);
    await reg.loadSuwayomiSources(async () => [{ id: '9', name: 'Clean', lang: 'en', isNsfw: true }]);
    const adapter = loader.getSource('sw:9');
    assert.ok(adapter, 'the enabled source should be registered');
    assert.equal(adapter!.isNsfw, true, 'the flag reached the database but not the adapter the routes check');
    assert.equal(adapter!.lang, 'en', 'the language must reach the adapter too, or it joins every group');
  });

  await t.test('more than 25 selected sources register without changing Providers disables', async () => {
    reset();
    await q('DELETE FROM suwayomi_sources');
    await reg.loadSuwayomiSources(async () => remote(40)); // remembers them, all unselected
    await q('UPDATE suwayomi_sources SET enabled = true');
    await q(`INSERT INTO source_health (source_id, disabled) VALUES ('sw:0',true),('sw:24',true)`);

    const r = await reg.loadSuwayomiSources(async () => remote(40));
    assert.equal(r.registered, 40, 'the former 25-source ceiling must not hide installed extensions');
    assert.equal(loader.listSources().length, 40);
    assert.ok(loader.getSource('sw:39')?.search, 'a source beyond the old cap must be a usable adapter');

    const disabled = async () => (await q<{ source_id: string }>(
      `SELECT source_id FROM source_health WHERE disabled = true AND source_id LIKE 'sw:%' ORDER BY source_id`,
    )).map((x) => x.source_id);
    assert.deepEqual(await disabled(), ['sw:0', 'sw:24']);

    reset();
    assert.equal((await reg.loadSuwayomiSources(async () => remote(40))).registered, 40);
    assert.deepEqual(await disabled(), ['sw:0', 'sw:24'],
      'registration must never auto-clear or invent an operator disable');
  });

  await t.test('an unreachable extension server registers nothing and does not throw', async () => {
    reset();
    const r = await reg.loadSuwayomiSources(async () => {
      throw new Error('fetch failed');
    });
    assert.equal(r.configured, true);
    assert.equal(r.reachable, false);
    assert.equal(r.registered, 0);
    assert.match(r.error || '', /fetch failed/);
    assert.equal(loader.listSources().length, 0);
  });

  await q('DELETE FROM suwayomi_sources');
  await q(`DELETE FROM source_health WHERE source_id LIKE 'sw:%'`);
});
