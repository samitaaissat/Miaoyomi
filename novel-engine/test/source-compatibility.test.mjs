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

// Compact fixtures preserve the captured site's structures; no captured pages ship.
const allNovelCatalog = '<div id="list-page"><div class="col-truyen-main archive"><div class="list list-truyen"><div class="title-list"><h2>Most Popular</h2></div><div class="row"><img src="/cover.webp"><h3 class="truyen-title"><a href="/fixture.html" title="Fixture Story">Fixture Story</a></h3></div></div></div></div>';
const allNovelDetail = '<div class="books"><img src="/cover.webp" title="Synthetic Story"></div><div id="rating" data-novel-id="237"></div>';

async function allNovelSolver(t, bodyForUrl) {
  const { NetworkBroker } = await import('../src/network.mjs');
  const entry = await pinnedEntry(t, 'allnovel');
  const broker = new NetworkBroker({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    solverUrl: 'http://solver:8191',
    transport: async () => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: Buffer.from('<title>Just a moment...</title>') }),
    solverFetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json(request.cmd === 'sessions.destroy' ? { status: 'ok' } : {
        status: 'ok', solution: { url: request.url, status: 200, headers: {}, cookies: [], userAgent: 'FixtureBrowser', response: bodyForUrl(request.url) },
      });
    },
  });
  t.after(() => broker.close());
  return (method, args) => runPlugin(entry.script, method, args, { fetch: (url, init) => broker.fetch(entry.source, url, init) });
}

test('AllNovel recovers its HTML catalog through the guarded solver fallback', async t => {
  const { NetworkBroker } = await import('../src/network.mjs');
  const entry = await pinnedEntry(t, 'allnovel');
  const broker = new NetworkBroker({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    solverUrl: 'http://solver:8191',
    transport: async () => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: Buffer.from('<title>Just a moment...</title>') }),
    solverFetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json(request.cmd === 'sessions.destroy' ? { status: 'ok' } : {
        status: 'ok', solution: { url: request.url, status: 200, headers: {}, cookies: [], userAgent: 'FixtureBrowser',
          response: allNovelCatalog },
      });
    },
  });
  t.after(() => broker.close());
  const novels = await runPlugin(entry.script, 'popularNovels', [1, {}], { fetch: (url, init) => broker.fetch(entry.source, url, init) });
  assert.deepEqual(novels, [{ cover: 'https://novelfull.com/cover.webp', path: 'fixture.html', name: 'Fixture Story' }]);
});

test('AllNovel marks listing search detail and chapter HTML while retaining AJAX request semantics', async t => {
  const { script } = await pinnedEntry(t, 'allnovel');
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    if (url.includes('ajax-chapter-option')) return { url, status: 200, headers: {}, body: '<a href="/fixture/chapter-1.html" title="Chapter 1">One</a>' };
    if (url.includes('ajax=chapters')) return { url, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ html: '<a href="/fixture/chapter-1.html" title="Chapter 1">One</a>', totalPage: 1 }) };
    if (!url.includes('.html')) return { url, status: 200, headers: { 'content-type': 'text/html' }, body: allNovelCatalog };
    return { url, status: 200, headers: { 'content-type': 'text/html' }, body: '<div class="books"><img src="/cover.jpg" title="Fixture"></div><div id="rating" data-novel-id="123"></div><script>window.chapterPagination = {totalChapters: 1}</script><div id="chapter-content"><p>Chapter prose.</p></div>' };
  };
  await runPlugin(script, 'popularNovels', [2, { showLatestNovels: true }], { fetch });
  await runPlugin(script, 'popularNovels', [1, { filters: { genres: { value: 'genre/Fantasy' } } }], { fetch });
  await runPlugin(script, 'searchNovels', ['fixture', 1], { fetch });
  const novel = await runPlugin(script, 'parseNovel', ['fixture.html'], { fetch });
  assert.equal(novel.chapters[0].path, 'fixture/chapter-1.html');
  assert.match(await runPlugin(script, 'parseChapter', ['fixture/chapter-1.html'], { fetch }), /Chapter prose/);
  const chapters = await runPlugin(script, 'fetchAllChaptersViaJsonAjax', ['fixture.html'], { fetch });
  assert.equal(chapters[0].path, 'fixture/chapter-1.html');
  for (const request of requests.filter(r => !r.url.includes('ajax'))) assert.equal(request.init.headers.accept, 'text/html', request.url);
  const post = requests.find(r => r.url.includes('ajax-chapter-option'));
  assert.equal(post.init.method, 'POST');
  assert.match(post.init.body, /novelId=123/);
  assert.equal(post.init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(post.init.headers['x-requested-with'], 'XMLHttpRequest');
  assert.equal(post.init.headers.accept, undefined);
  const json = requests.find(r => r.url.includes('ajax=chapters'));
  assert.equal(json.init.headers.accept, undefined);
});

// Synthetic detail and option markup: exercises the non-paginated HTML GET branch.
test('AllNovel recovers HTML chapter options through the guarded solver fallback', async t => {
  const { NetworkBroker } = await import('../src/network.mjs');
  const entry = await pinnedEntry(t, 'allnovel');
  const broker = new NetworkBroker({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    solverUrl: 'http://solver:8191',
    transport: async () => ({ status: 403, headers: { 'cf-mitigated': 'challenge' }, body: Buffer.from('<title>Just a moment...</title>') }),
    solverFetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.cmd === 'sessions.destroy') return Response.json({ status: 'ok' });
      const detail = request.url === 'https://novelfull.com/fixture.html';
      if (!detail) assert.equal(request.url, 'https://novelfull.com/ajax-chapter-option?novelId=237');
      return Response.json({ status: 'ok', solution: {
        url: request.url, status: 200, headers: {}, cookies: [], userAgent: 'FixtureBrowser',
        response: detail
          ? '<div class="books"><img src="/cover.webp" title="Synthetic Story"></div><div id="rating" data-novel-id="237"></div>'
          : '<select id="chapter-nav" class="btn btn-success form-control chapter_jump"><option value="/fixture/chapter-1.html">Chapter 1 - Arrival</option><option value="/fixture/chapter-2.html">Chapter 2 - Departure</option></select>',
      } });
    },
  });
  t.after(() => broker.close());
  const novel = await runPlugin(entry.script, 'parseNovel', ['fixture.html'], { fetch: (url, init) => broker.fetch(entry.source, url, init) });
  assert.equal(novel.name, 'Synthetic Story');
  assert.deepEqual(novel.chapters, [
    { path: 'fixture/chapter-1.html', name: 'Chapter 1 - Arrival', releaseTime: null },
    { path: 'fixture/chapter-2.html', name: 'Chapter 2 - Departure', releaseTime: null },
  ]);
});

test('AllNovel chapter-option HTML marker stays confined to the exact same-origin GET contract', async t => {
  const entry = await pinnedEntry(t, 'allnovel');
  const script = entry.script + '\nmodule.exports.default.probeRequest = (url, init) => require("@libs/fetch").fetchApi(url, init).then(r => r.text());';
  const cases = [
    ['https://novelfull.com/ajax-chapter-option?novelId=237', {}, 'text/html'],
    ['https://novelfull.com/ajax-chapter-option?novelId=237', { method: 'get' }, 'text/html'],
    ['https://novelfull.com/ajax-chapter-option/', {}, undefined],
    ['https://novelfull.com/ajax/chapter-list?novelId=237', {}, undefined],
    ['https://novelfull.com/ajax-chapter-option?ajax=chapters', {}, undefined],
    ['https://example.org/ajax-chapter-option?novelId=237', {}, undefined],
    ['https://novelfull.com/ajax-chapter-option', { headers: { Accept: 'application/json' } }, 'application/json'],
    ['https://novelfull.com/ajax-chapter-option', { headers: { 'X-Requested-With': 'XMLHttpRequest' } }, undefined],
    ['https://novelfull.com/ajax-chapter-option', { method: 'POST', body: 'novelId=237', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, undefined],
  ];
  for (const [url, init, accept] of cases) {
    const body = accept === 'text/html' ? '<select id="chapter-nav"></select>' : 'synthetic response';
    const result = await runPlugin(script, 'probeRequest', [url, init], { fetch: async (actualUrl, actualInit) => {
      assert.equal(actualUrl, url);
      assert.equal(actualInit.headers.accept, accept, url);
      if (init.body) assert.equal(actualInit.body, 'novelId=237');
      if (init.method) assert.equal(actualInit.method, init.method);
      return { url, status: 200, headers: {}, body };
    } });
    assert.equal(result, body);
  }
});

for (const [label, body] of [
  ['error page', '<title>Not found</title><h1>404 Not Found</h1>'],
  ['unrelated HTML', '<html><body><h2>Welcome</h2></body></html>'],
  ['broken row', '<div id="list-page"><div class="archive"><div class="list-truyen"><div class="title-list"><h2>Popular</h2></div><div class="row"><h3><a>Broken novel</a></h3></div></div></div></div>'],
]) {
  test('AllNovel rejects solver catalog ' + label, async t => {
    const run = await allNovelSolver(t, () => body);
    await assert.rejects(run('popularNovels', [1, {}]), error => error.code === 'SOURCE_RESPONSE' && /catalog/i.test(error.message));
  });
}

test('AllNovel retains genuine empty search and valid end-of-pagination catalogs', async t => {
  // From the public no-result capture: list-page/archive/list-truyen/title-list,
  // no novel rows, and the real no-results message.
  const run = await allNovelSolver(t, url => '<div class="container" id="list-page"><div class="col-xs-12 col-sm-12 col-md-9 col-truyen-main archive"><div class="list list-truyen col-xs-12"><div class="title-list"><h2>' + (url.includes('/search?') ? 'Search: MiaoyomiNoSuchNovelProbe986574321' : 'Most Popular') + '</h2></div>' + (url.includes('/search?') ? '<p class="text-center" style="padding:24px 0">No results for “MiaoyomiNoSuchNovelProbe986574321”.</p>' : '') + '</div></div></div>');
  assert.deepEqual(await run('searchNovels', ['MiaoyomiNoSuchNovelProbe986574321', 1]), []);
  assert.deepEqual(await run('popularNovels', [9999, {}]), []);
});

for (const [label, body] of [
  ['error page', '<title>Not found</title><h1>404 Not Found</h1>'],
  ['unrelated links', '<a href="/fixture/chapter-1.html">Chapter 1</a>'],
  ['wrong select', '<select id="other-nav"><option value="/fixture/chapter-1.html">One</option></select>'],
  ['missing option value', '<select id="chapter-nav"><option>One</option></select>'],
  ['truncated select', '<select id="chapter-nav"><option value="/fixture/chapter-1.html">One</option>'],
]) {
  test('AllNovel rejects solver chapter options ' + label, async t => {
    const run = await allNovelSolver(t, url => url.includes('/ajax-chapter-option?') ? body : allNovelDetail);
    await assert.rejects(run('parseNovel', ['fixture.html']), error => error.code === 'SOURCE_RESPONSE' && /chapter options/i.test(error.message));
  });
}

test('AllNovel retains a legitimate empty chapter-nav select', async t => {
  const run = await allNovelSolver(t, url => url.includes('/ajax-chapter-option?') ? '<select id="chapter-nav" class="btn btn-success form-control chapter_jump"></select>' : allNovelDetail);
  const novel = await run('parseNovel', ['fixture.html']);
  assert.equal(novel.name, 'Synthetic Story');
  assert.deepEqual(novel.chapters, []);
});

for (const [kind, method, path, bodies] of [
  ['detail', 'parseNovel', 'fixture.html', [
    ['error page', '<title>Not found</title><h1>404 Not Found</h1>'],
    ['missing name', '<div class="books"><img src="/cover.webp"></div><div id="rating" data-novel-id="237"></div>'],
    ['catalog in place of detail', allNovelCatalog],
  ]],
  ['chapter', 'parseChapter', 'fixture/chapter-1.html', [
    ['error page', '<title>Not found</title><h1>404 Not Found</h1>'],
    ['missing content', '<html><body><h2>Chapter 1</h2></body></html>'],
    ['empty content', '<div id="chapter-content"> </div>'],
  ]],
]) {
  for (const [label, body] of bodies) {
    test('AllNovel rejects solver ' + kind + ' ' + label, async t => {
      const run = await allNovelSolver(t, () => body);
      await assert.rejects(run(method, [path]), error => error.code === 'SOURCE_RESPONSE' && error.message.includes(kind));
    });
  }
}

test('AllNovel preserves pinned chapter prose parsing after validation', async t => {
  const run = await allNovelSolver(t, () => '<div id="chapter-content"><p>Hello reader.</p><div class="ads">Advertisement</div><p>Second paragraph.</p></div>');
  const chapter = await run('parseChapter', ['fixture/chapter-1.html']);
  assert.match(chapter, /<p>Hello reader\.<\/p>/);
  assert.match(chapter, /<p>Second paragraph\.<\/p>/);
  assert.doesNotMatch(chapter, /Advertisement/);
});

for (const [kind, method, path, body] of [
  ['catalog', 'popularNovels', null, allNovelCatalog.slice(0, -6)],
  ['detail', 'parseNovel', 'fixture.html', '<div class="books"><img src="/cover.webp" title="Truncated Story">'],
  ['chapter', 'parseChapter', 'fixture/chapter-1.html', '<div id="chapter-content"><p>Truncated prose.</p>'],
]) {
  test('AllNovel rejects truncated solver ' + kind + ' structure', async t => {
    const run = await allNovelSolver(t, () => body);
    await assert.rejects(run(method, path ? [path] : [1, {}]), error => error.code === 'SOURCE_RESPONSE' && error.message.includes(kind));
  });
}

for (const [kind, method, path, body] of [
  ['catalog', 'popularNovels', null, allNovelCatalog],
  ['detail', 'parseNovel', 'fixture.html', allNovelDetail],
  ['chapter', 'parseChapter', 'fixture/chapter-1.html', '<div id="chapter-content">Error page text.</div>'],
  ['chapter options', 'parseNovel', 'fixture.html', '<select id="chapter-nav"></select>'],
]) {
  test('AllNovel rejects error document identity despite ' + kind + ' markup', async t => {
    const run = await allNovelSolver(t, url => kind === 'chapter options' && !url.includes('/ajax-chapter-option?')
      ? allNovelDetail : '<title>404 Not Found</title><h1>404 Not Found</h1>' + body);
    await assert.rejects(run(method, path ? [path] : [1, {}]), error => error.code === 'SOURCE_RESPONSE' && error.message.includes(kind));
  });
}

test('AllNovel rejects a chapter containing only adapter-hidden content', async t => {
  const run = await allNovelSolver(t, () => '<div id="chapter-content"><div class="ads">Advertisement</div><div class="unlock-buttons">Unlock</div><iframe>Frame content</iframe><sub>Hidden</sub></div>');
  await assert.rejects(run('parseChapter', ['fixture/chapter-1.html']), error => error.code === 'SOURCE_RESPONSE' && /chapter/i.test(error.message));
});


test('AllNovel validation stays isolated from another guest invocation', async t => {
  const entry = await pinnedEntry(t, 'allnovel');
  const probe = '\nmodule.exports.default.probeRequest = url => require("@libs/fetch").fetchApi(url).then(r => r.text());';
  const allNovel = entry.script + probe;
  const unrelated = 'exports.default = {};' + probe;
  const url = 'https://novelfull.com/most-popular?page=1';
  const results = await Promise.all([
    runPlugin(allNovel, 'probeRequest', [url], { fetch: async (_url, init) => {
      assert.equal(init.headers.accept, 'text/html');
      return { url, status: 200, headers: {}, body: allNovelCatalog };
    } }),
    runPlugin(unrelated, 'probeRequest', [url], { fetch: async (_url, init) => {
      assert.equal(init.headers.accept, undefined);
      return { url, status: 200, headers: {}, body: 'Unrelated response' };
    } }),
  ]);
  assert.deepEqual(results, [allNovelCatalog, 'Unrelated response']);
});
