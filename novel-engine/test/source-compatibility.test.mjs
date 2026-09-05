import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from '../src/registry.mjs';
import { runPlugin } from '../src/runtime.mjs';

async function pinnedEntry(t, id) {
  const stateDir = await mkdtemp(join(tmpdir(), `novel-${id}-`));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  return (await Registry.open({ stateDir })).entry(id);
}

test('Arcane follows its migration with the reviewed NovelDex catalog API', async t => {
  const entry = await pinnedEntry(t, 'arcane');
  const script = entry.script;
  assert.equal(entry.source.site, 'https://noveldex.io/');
  const metadata = await runPlugin(script, '__metadata');
  assert.deepEqual(metadata.filters, {});
  const requested = [];
  const fetch = async url => {
    requested.push(url);
    const expected = url.includes('/search?')
      ? 'https://noveldex.io/api/ai/search?q=fixture%20story&limit=20'
      : 'https://noveldex.io/api/ai/series?page=2&limit=20&type=novel&sort=popular';
    assert.equal(url, expected);
    const item = {
      slug: 'fixture-story',
      title: 'Fixture Story',
      cover_image: 'https://noveldex.io/uploads/fixture.webp',
    };
    return {
      url,
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(url.includes('/search?')
        ? { query: 'fixture story', results: [item], total: 1 }
        : { data: [item], pagination: { page: 2, total_pages: 3 } }),
    };
  };

  const novels = await runPlugin(script, 'popularNovels', [2, {}], { fetch });
  const search = await runPlugin(script, 'searchNovels', ['fixture story', 1], { fetch });

  const expected = [{
    name: 'Fixture Story',
    path: 'fixture-story',
    cover: 'https://noveldex.io/uploads/fixture.webp',
  }];
  assert.deepEqual(novels, expected);
  assert.deepEqual(search, expected);
  assert.equal(requested.length, 2);
});

test('Arcane maps migrated NovelDex detail and public chapter HTML', async t => {
  const script = (await pinnedEntry(t, 'arcane')).script;
  const fetch = async (url, init) => {
    if (url === 'https://noveldex.io/api/ai/series/fixture-story') return {
      url,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'fixture-story',
        title: 'Fixture Story',
        description: 'A fixture summary.',
        cover_image: 'https://noveldex.io/uploads/fixture.webp',
        author: 'Fixture Author',
        artist: 'Fixture Artist',
        status: 'ONGOING',
        genres: ['Fantasy', 'Mystery'],
        chapters: [
          { number: 1, title: 'Arrival', is_premium: false, published_at: '2026-01-02T03:04:05.000Z' },
          { number: 2, title: 'Locked Door', is_premium: true, published_at: '2026-01-03T03:04:05.000Z' },
        ],
      }),
    };
    assert.equal(url, 'https://noveldex.io/series/novel/fixture-story/chapter/1');
    assert.equal(init.useWebView, true);
    return {
      url,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<section data-chapter-number="1"><div data-paragraph-key="one"><div class="prose"><p>Hello reader.</p></div></div><div data-paragraph-key="two"><div class="prose"><p>Second paragraph.</p></div></div></section>',
    };
  };

  const novel = await runPlugin(script, 'parseNovel', ['series/fixture-story/'], { fetch });
  assert.deepEqual(novel, {
    path: 'fixture-story',
    name: 'Fixture Story',
    cover: 'https://noveldex.io/uploads/fixture.webp',
    summary: 'A fixture summary.',
    author: 'Fixture Author',
    artist: 'Fixture Artist',
    status: 'Ongoing',
    genres: 'Fantasy, Mystery',
    chapters: [
      { name: 'Arrival', path: 'fixture-story/chapter/1', chapterNumber: 1, releaseTime: '2026-01-02T03:04:05.000Z' },
      { name: '🔒 Locked Door', path: 'fixture-story/chapter/2', chapterNumber: 2, releaseTime: '2026-01-03T03:04:05.000Z' },
    ],
  });
  assert.equal(
    await runPlugin(script, 'parseChapter', ['fixture-story/chapter/1'], { fetch }),
    '<p>Hello reader.</p><p>Second paragraph.</p>',
  );
  assert.equal(
    await runPlugin(script, 'resolveUrl', ['series/fixture-story/', true]),
    'https://noveldex.io/series/novel/fixture-story',
  );
  assert.equal(
    await runPlugin(script, 'resolveUrl', ['fixture-story/chapter/2', false]),
    'https://noveldex.io/series/novel/fixture-story/chapter/2',
  );
});

test('Arcane rejects incomplete migrated API and chapter responses instead of returning empty results', async t => {
  const script = (await pinnedEntry(t, 'arcane')).script;
  const malformedCatalog = async url => ({
    url,
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pagination: { page: 1, total_pages: 1 } }),
  });
  await assert.rejects(
    runPlugin(script, 'popularNovels', [1, {}], { fetch: malformedCatalog }),
    error => error.code === 'SOURCE_RESPONSE' && /catalog/i.test(error.message),
  );

  const emptyChapter = async url => ({
    url,
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: '<html><body><a href="/login">Sign in to continue</a></body></html>',
  });
  await assert.rejects(
    runPlugin(script, 'parseChapter', ['fixture-story/chapter/2'], { fetch: emptyChapter }),
    error => error.code === 'SOURCE_INTERSTITIAL' && /browser access/i.test(error.message),
  );
});

test('Crimson Scrolls accepts WordPress success envelopes around list HTML', async t => {
  const script = (await pinnedEntry(t, 'crimsonscrolls')).script;
  const fetch = async (url, init) => {
    assert.equal(url, 'https://crimsonscrolls.net/wp-admin/admin-ajax.php');
    assert.equal(init.method, 'POST');
    assert.match(init.body, /name="action"\r\n\r\nload_novels/);
    return {
      url,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        success: true,
        data: {
          html: '<a class="live-search-item" href="https://crimsonscrolls.net/novel/fixture"><div class="live-search-title">Crimson Fixture</div><img class="live-search-cover" src="cover.jpg"></a>',
        },
      }),
    };
  };

  const novels = await runPlugin(script, 'popularNovels', [1, {}], { fetch });

  assert.deepEqual(novels, [{ name: 'Crimson Fixture', cover: 'cover.jpg', path: 'novel/fixture' }]);
});

test('Webnovel marks its HTML fetches for the solver rendered-page fallback', async t => {
  const script = (await pinnedEntry(t, 'webnovel')).script;
  let request;
  const fetch = async (url, init) => {
    request = { url, init };
    return {
      url,
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<div class="j_category_wrapper"><li><a class="g_thumb" title="Webnovel Fixture" href="/book/fixture"><img data-original="//img.example/fixture.jpg"></a></li></div>',
    };
  };

  const novels = await runPlugin(script, 'popularNovels', [1, {}], { fetch });

  assert.equal(request.init.headers.accept, 'text/html');
  assert.deepEqual(novels, [{
    name: 'Webnovel Fixture',
    cover: 'https://img.example/fixture.jpg',
    path: '/book/fixture',
  }]);
});
