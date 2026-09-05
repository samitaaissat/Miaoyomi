import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..', '..');
const out = join(webRoot, 'out');
const artifacts = process.env.ARTIFACT_DIR || join(webRoot, '..', '.superpowers', 'sdd', '2026-09-05-miaoyomi');
await mkdir(artifacts, { recursive: true });

const users = {
  a: { id: 'browser-account-a', username: 'reader-a', displayName: 'Reader A', role: 'admin', settings: { locale: 'en' }, perms: { canDownload: true } },
  b: { id: 'browser-account-b', username: 'reader-b', displayName: 'Reader B', role: 'user', settings: { locale: 'en' }, perms: { canDownload: true } },
};
let active = 'a';
let failChapterNetwork = false;
const browseRequests = [];
const searchRequests = [];
const detailRequests = [];
let failNextBrowsePage = false;
const exportRequests = [];
const progressRequests = [];
const payload = {
  novelId: 'novel-1', chapterId: 'chapter-1', novelTitle: 'The Glass Orchard', chapterTitle: 'A Door in Winter',
  html: '<p>The orchard waited under snow.</p><p>Beyond the glass, a bell rang once.</p>',
  sourceUrl: 'https://fiction.test/chapter-1', archiveRevision: 'a'.repeat(64), nextChapterId: 'chapter-2',
};
const detail = {
  id: 'novel-1', sourceId: 'royalroad', path: '/fiction/glass-orchard', title: 'The Glass Orchard', author: 'M. Vale',
  summary: 'A winter-bound archivist finds a door where no door should be.', language: 'en', inLibrary: false, totalPages: 2,
  chapters: [
    { id: 'chapter-1', path: '/chapter/1', title: 'A Door in Winter', number: 1, position: 0, saved: true },
    { id: 'chapter-2', path: '/chapter/2', title: 'Second Light', number: 2, position: 1, saved: false },
  ],
};
const sources = { sources: [
  { id: 'royalroad', name: 'Royal Road', lang: 'en', site: 'https://fiction.test', version: '2.3.1', enabled: true, supported: true, supportsLatest: true,
    filters: { orderBy: { type: 'Picker', label: 'Order', value: 'views', options: [{ label: 'Views', value: 'views' }, { label: 'Rating', value: 'rating' }] } } },
  { id: 'scribblehub', name: 'Scribble Hub', lang: 'en', site: 'https://scribble.test', version: '1.0.0', enabled: true, supported: true, supportsLatest: false },
  { id: 'slow', name: 'Slow Fiction', lang: 'fr', site: 'https://slow.test', version: '1.0.0', enabled: true, supported: true, supportsLatest: true },
  { id: 'challenge', name: 'Challenge Fiction', lang: 'en', site: 'https://blocked.test', version: '1.0.0', enabled: false, supported: false, supportsLatest: false, reason: 'This source requires a browser challenge.' },
] };

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const bodyOf = async (req) => { let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/__fixture/switch') { active = url.searchParams.get('user') || 'a'; failChapterNetwork = url.searchParams.get('fail') === '1'; return json(res, 200, { ok: true }); }
  if (url.pathname === '/auth/refresh') return json(res, active ? 200 : 401, active ? { accessToken: `token-${active}` } : { error: 'signed_out' });
  if (url.pathname === '/auth/me') return json(res, 200, users[active]);
  if (url.pathname === '/auth/config') return json(res, 200, { oidc: { enabled: false, name: '' } });
  if (url.pathname === '/auth/login') { const body = await bodyOf(req); active = body.username?.includes('b') ? 'b' : 'a'; return json(res, 200, { accessToken: `token-${active}`, user: users[active] }); }
  if (url.pathname === '/auth/logout') { active = ''; return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/setup/status') return json(res, 200, { needsSetup: false });
  if (url.pathname === '/api/settings') return json(res, 200, { lang: 'en' });
  if (url.pathname === '/api/updates') return json(res, 200, { content: [] });
  if (url.pathname === '/api/novels/sources') return json(res, 200, sources);
  if (url.pathname.startsWith('/api/novels/sources/')) return json(res, 200, { source: sources.sources[0] });
  if (url.pathname === '/api/novels/browse') {
    browseRequests.push(url.search);
    const page = Number(url.searchParams.get('page'));
    if (page > 1 && failNextBrowsePage) { failNextBrowsePage = false; return json(res, 503, { message: 'Page temporarily unavailable.' }); }
    const selected = url.searchParams.getAll('sourceIds');
    if (url.searchParams.has('sourceId')) selected.push(url.searchParams.get('sourceId'));
    const eligible = sources.sources.filter((source) => source.enabled && source.supported
      && (!selected.length || selected.includes(source.id))
      && (!url.searchParams.has('lang') || source.lang === url.searchParams.get('lang'))
      && (url.searchParams.get('mode') !== 'latest' || source.supportsLatest));
    const items = [];
    if (eligible.some((source) => source.id === 'royalroad')) items.push(...(page === 1
      ? [{ sourceId: 'royalroad', path: detail.path, title: detail.title }]
      : [{ sourceId: 'royalroad', path: '/fiction/second', title: 'Second Light' }]));
    if (page === 1 && eligible.some((source) => source.id === 'scribblehub')) items.push({ sourceId: 'scribblehub', path: detail.path, title: 'Ink and Ash' });
    const errors = eligible.some((source) => source.id === 'slow') ? [{ sourceId: 'slow', sourceName: 'Slow Fiction', code: 'timeout', message: 'Source timed out.' }] : [];
    return json(res, 200, { items: items.map((item) => ({ ...item, id: `discovered-${item.sourceId}` })), page, hasMore: page === 1 && items.length > 0, nextCursor: page === 1 && items.length > 0 ? 'browse-next+/=' : undefined, errors });
  }
  if (url.pathname === '/api/novels/search') {
    searchRequests.push(url.search);
    const page = Number(url.searchParams.get('page'));
    return json(res, 200, { items: page === 1
      ? [{ id: 'discovered-royalroad', sourceId: 'royalroad', path: detail.path, title: detail.title }, { id: 'discovered-scribblehub', sourceId: 'scribblehub', path: detail.path, title: 'Ink and Ash' }]
      : [{ id: 'discovered-royalroad', sourceId: 'royalroad', path: detail.path, title: detail.title }, { id: 'discovered-search', sourceId: 'scribblehub', path: '/fiction/search-second', title: 'A Search Beyond' }], page,
      hasMore: page === 1, nextCursor: page === 1 ? 'search-next+/=' : undefined, errors: [] });
  }
  if (url.pathname === '/api/novels/detail' || url.pathname === '/api/novels/novel-1') { detailRequests.push(url.pathname + url.search); return json(res, 200, detail); }
  if (url.pathname.startsWith('/api/novels/discovered-')) return json(res, 404, { message: 'This title has not been opened from its source yet.' });
  if (url.pathname === '/api/novels/library') return json(res, 200, { items: active === 'a' ? [{ ...detail, inLibrary: true, progress: null }] : [] });
  if (url.pathname === '/api/novels/novel-1/export.epub') {
    exportRequests.push(req.headers.authorization);
    if (req.headers.authorization !== `Bearer token-${active}`) return json(res, 401, { error: 'unauthorized' });
    res.writeHead(200, { 'content-type': 'application/epub+zip' });
    return res.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]));
  }
  if (url.pathname === '/api/novels/novel-1/progress' && req.method === 'GET') return json(res, 200, { progress: null });
  if (url.pathname === '/api/novels/novel-1/progress' && req.method === 'PUT') {
    const progress = await bodyOf(req);
    progressRequests.push(progress);
    return json(res, 200, { progress });
  }
  if (url.pathname.endsWith('/library')) return json(res, 200, { ok: true });
  if (url.pathname.endsWith('/chapters/refresh')) return json(res, 200, detail);
  if (url.pathname.endsWith('/chapters/chapter-1/open')) return failChapterNetwork ? json(res, 503, { error: 'offline', message: 'Chapter network unavailable.' }) : json(res, 200, payload);
  if (url.pathname.endsWith('/chapters/chapter-2/open')) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    return json(res, 200, { ...payload, chapterId: 'chapter-2', chapterTitle: 'Second Light', previousChapterId: 'chapter-1', nextChapterId: undefined });
  }
  if (url.pathname.startsWith('/api/')) return json(res, 200, {});

  let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (!relative || url.pathname.endsWith('/')) relative += 'index.html';
  let file = normalize(join(out, relative));
  if (!file.startsWith(out)) { res.writeHead(403); return res.end(); }
  if (!extname(file) && existsSync(join(file, 'index.html'))) file = join(file, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': mime[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const systemChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(systemChrome)
  ? systemChrome
  : undefined);
const browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1 });
  await page.goto(`${base}/novels/`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('The Glass Orchard'));
  const firstBrowse = new URLSearchParams(browseRequests[0]);
  assert.equal(firstBrowse.has('sourceId'), false, 'discovery automatically selected its first source');
  assert.equal(firstBrowse.has('sourceIds'), false, 'discovery narrowed its default source scope');
  assert.ok(await page.evaluate(() => document.body.innerText.includes('Ink and Ash')), 'default discovery omitted another source');
  assert.equal(await page.$('select[aria-label="Novel source"]'), null, 'discovery still requires the standalone source picker');
  const discoveredHref = await page.evaluate(() => [...document.querySelectorAll('a')].find((node) => node.textContent.includes('The Glass Orchard'))?.getAttribute('href'));
  assert.ok(discoveredHref.includes('sourceId=royalroad'), 'a discovery id was treated as an already saved novel');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('a')].some((node) => node.textContent.includes('Ink and Ash') && node.textContent.includes('Scribble Hub'))), 'novel cards omitted their source attribution');
  assert.ok(await page.evaluate(() => document.querySelector('[role="status"]')?.textContent.includes('Slow Fiction')), 'partial source failure was hidden');
  const mobileLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(mobileLayout.scroll <= mobileLayout.width + 1, `mobile novel discovery overflows by ${mobileLayout.scroll - mobileLayout.width}px`);
  await page.screenshot({ path: join(artifacts, 'task-3-novel-discover-aggregate.png'), fullPage: true });
  failNextBrowsePage = true;
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Load more')?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Page temporarily unavailable.'));
  assert.ok(await page.evaluate(() => document.body.innerText.includes('The Glass Orchard') && document.body.innerText.includes('Ink and Ash')), 'a failed next page erased existing results');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Retry loading more')?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Second Light'));
  assert.equal(new URLSearchParams(browseRequests.at(-1)).get('cursor'), 'browse-next+/=', 'browse lost the per-source continuation');
  await page.click('details summary');
  await page.click('input[aria-label="Source Royal Road"]');
  await page.waitForFunction(() => !document.body.innerText.includes('Ink and Ash'));
  await page.select('details select', 'rating');
  await page.waitForFunction(() => document.body.innerText.includes('Load more'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Load more'))?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Second Light'));
  assert.ok(browseRequests.some((query) => query.includes('page=2')), 'browse pagination did not request page 2');
  assert.ok(browseRequests.some((query) => decodeURIComponent(query).includes('"value":"rating"')), 'typed filter value did not reach the browse request');
  await page.click('input[aria-label="Source Scribble Hub"]');
  await page.waitForFunction(() => document.body.innerText.includes('Ink and Ash'));
  const narrowedBrowse = new URLSearchParams(browseRequests.at(-1));
  assert.deepEqual(narrowedBrowse.getAll('sourceIds'), ['royalroad', 'scribblehub'], 'multiple source selection did not reach browse');
  assert.equal(narrowedBrowse.get('page'), '1', 'source selection kept the previous page');
  assert.equal(narrowedBrowse.has('cursor'), false, 'source selection kept the previous cursor');
  assert.equal(narrowedBrowse.has('filters'), false, 'single-source filters leaked into aggregated requests');
  await page.type('input[aria-label="Search novels"]', 'glass');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.body.textContent.includes('Results for “glass”'));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Load more')?.click());
  await page.waitForFunction(() => document.body.innerText.includes('A Search Beyond'));
  const searchPage = new URLSearchParams(searchRequests.at(-1));
  assert.deepEqual(searchPage.getAll('sourceIds'), ['royalroad', 'scribblehub']);
  assert.equal(searchPage.get('cursor'), 'search-next+/=', 'search lost its source continuation');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('h3')].filter((node) => node.textContent === 'The Glass Orchard').length), 1, 'pagination repeated the same source title');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'All sources')?.click());
  await page.waitForNetworkIdle();
  assert.equal(new URLSearchParams(searchRequests.at(-1)).has('sourceIds'), false, 'all-sources reset did not apply during search');
  await page.screenshot({ path: join(artifacts, 'task-3-novel-discover.png'), fullPage: true });

  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Clear')?.click());
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Latest')?.click());
  await page.waitForNetworkIdle();
  const latestBrowse = new URLSearchParams(browseRequests.at(-1));
  assert.equal(latestBrowse.get('mode'), 'latest');
  assert.equal(latestBrowse.get('page'), '1', 'switching mode kept the old page');
  assert.equal(latestBrowse.has('cursor'), false, 'switching mode kept the old cursor');
  assert.ok(!await page.evaluate(() => document.body.innerText.includes('Ink and Ash')), 'latest included a source without latest support');
  await page.click('input[aria-label="Source Slow Fiction"]');
  await page.waitForFunction(() => document.body.innerText.includes('No titles available yet'));
  assert.ok(await page.evaluate(() => document.querySelector('[role="status"]')?.textContent.includes('Slow Fiction')), 'complete source failure looked like successful empty results');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'en')?.click());
  await page.waitForNetworkIdle();
  assert.ok(await page.evaluate(() => document.querySelector('input[aria-label="Source Slow Fiction"]')?.checked), 'changing language silently cleared an explicit source filter');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'All sources')?.click());
  await page.waitForFunction(() => document.body.innerText.includes('The Glass Orchard'));
  const languageBrowse = new URLSearchParams(browseRequests.at(-1));
  assert.equal(languageBrowse.get('lang'), 'en');
  assert.equal(languageBrowse.has('sourceIds'), false);

  await page.evaluate(() => [...document.querySelectorAll('a')].find((node) => node.textContent.includes('The Glass Orchard'))?.click());
  await page.waitForFunction(() => document.body.innerText.includes('Start reading'));
  assert.ok(detailRequests.some((request) => request.startsWith('/api/novels/detail?') && request.includes('sourceId=royalroad')), 'opening a discovered card did not hydrate its source details');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Export saved EPUB'))?.click());
  await page.waitForNetworkIdle();
  assert.deepEqual(exportRequests, ['Bearer token-a'], 'EPUB export did not use authenticated binary fetch');
  await page.evaluate(() => [...document.querySelectorAll('a')].find((node) => node.textContent?.includes('Start reading'))?.click());
  await page.waitForFunction(() => document.body.innerText.includes('The orchard waited under snow.'));
  await page.click('button[aria-label="Download chapter"]');
  await page.waitForSelector('button[aria-label="Remove download"]');
  await page.screenshot({ path: join(artifacts, 'task-3-novel-reader-online.png'), fullPage: true });

  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // Save Offline primes this exact navigation even though title → reader was an SPA transition. Do not
  // perform an online reload here: the behavior under test is close immediately, then reopen offline.
  // The download button only reports success after the worker acknowledges the cached shell.
  const cachedNavigations = await page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) if (name.startsWith('yomi-shell-')) {
      const cache = await caches.open(name);
      result.push(...(await cache.keys()).map((request) => request.url));
    }
    return result;
  });
  assert.ok(cachedNavigations.includes(page.url()), `Save Offline did not prime ${page.url()}; cached ${cachedNavigations.join(', ')}`);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => document.body.innerText.includes('The orchard waited under snow.'), { timeout: 15000 });
  } catch (error) {
    console.error('Offline body:', await page.evaluate(() => document.body.innerText));
    throw error;
  }
  const offlineProseVisible = await page.evaluate(() => {
    const paragraph = [...document.querySelectorAll('p')].find((node) => node.textContent?.includes('The orchard waited under snow.'));
    if (!paragraph) return false;
    const rect = paragraph.getBoundingClientRect();
    const style = getComputedStyle(paragraph);
    return {
      visible: rect.width > 20 && rect.height > 10 && rect.bottom > 0 && rect.top < innerHeight && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0,
      rect: { top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      color: style.color,
      background: getComputedStyle(document.querySelector('.h-screen-d')).backgroundColor,
      windowScroll: scrollY,
      readerScroll: document.querySelector('.overflow-y-auto')?.scrollTop,
    };
  });
  assert.equal(offlineProseVisible.visible, true, `downloaded prose existed but was not visibly rendered offline: ${JSON.stringify(offlineProseVisible)}`);
  await page.screenshot({ path: join(artifacts, 'task-3-novel-reader-offline.png'), fullPage: true });

  await page.setOfflineMode(false);
  await fetch(`${base}/__fixture/switch?user=b&fail=1`);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Chapter unavailable'));
  assert.ok(!await page.evaluate(() => document.body.innerText.includes('The orchard waited under snow.')), 'account B read account A’s downloaded prose');
  await page.screenshot({ path: join(artifacts, 'task-3-novel-account-isolation.png'), fullPage: true });

  await fetch(`${base}/__fixture/switch?user=a&fail=1`);
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('The orchard waited under snow.'));
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(`${base}/novels/`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('The Glass Orchard'));
  const wideLayout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(wideLayout.scroll <= wideLayout.width + 1, `desktop novel discovery overflows by ${wideLayout.scroll - wideLayout.width}px`);
  await page.screenshot({ path: join(artifacts, 'task-3-novel-discover-desktop.png'), fullPage: true });

  // Keep this QueryClient alive across a real logout/login. A hard reload would hide account-key bugs.
  await page.click('a[href*="view=library"]');
  await page.waitForFunction(() => document.body.innerText.includes('The Glass Orchard'));
  await page.click('a[href*="view=offline"]');
  await page.waitForFunction(() => document.body.innerText.includes('1 chapter downloaded'));
  await page.click('a[href^="/profile"]');
  try { await page.waitForFunction(() => [...document.querySelectorAll('button')].some((node) => node.textContent?.trim() === 'Sign out'), { timeout: 8000 }); }
  catch (error) { console.error('Profile fixture:', page.url(), await page.evaluate(() => document.body.innerText)); throw error; }
  await page.evaluate(() => [...document.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Sign out')?.click());
  await page.waitForSelector('input[type="password"]');
  await page.type('input[type="text"]', 'reader-b');
  await page.type('input[type="password"]', 'fixture-password');
  await page.click('button[type="submit"]');
  await page.waitForSelector('a[href="/novels/"]');
  await page.click('a[href="/novels/"]');
  await page.waitForSelector('a[href*="view=library"]');
  await page.click('a[href*="view=library"]');
  await page.waitForFunction(() => document.body.innerText.includes('Your novel shelf is empty'));
  assert.ok(!await page.evaluate(() => document.body.innerText.includes('The Glass Orchard')), 'same-tab account B reused A’s library query cache');
  await page.click('a[href*="view=offline"]');
  await page.waitForFunction(() => document.body.innerText.includes('No downloaded novel chapters'));
  assert.ok(!await page.evaluate(() => document.body.innerText.includes('The Glass Orchard')), 'same-tab account B reused A’s offline query cache');
  await page.screenshot({ path: join(artifacts, 'task-3-novel-same-tab-isolation.png'), fullPage: true });

  // A separate device starts with a long uncached chapter. Leaving before the debounce fires must save
  // its current position, and the next query-routed chapter must start with fresh reader state.
  await fetch(`${base}/__fixture/switch?user=a&fail=0`);
  payload.html = '<p>A measured step through the orchard.</p>'.repeat(120);
  const secondDevice = await browser.createBrowserContext();
  try {
    const reader = await secondDevice.newPage();
    await reader.setViewport({ width: 412, height: 915 });
    await reader.goto(`${base}/novels/read/?novelId=novel-1&chapterId=chapter-1`, { waitUntil: 'networkidle2' });
    await reader.waitForSelector('.novel-prose');
    await reader.evaluate(async () => {
      const scroller = document.querySelector('[data-lenis-prevent]');
      scroller.style.scrollBehavior = 'auto';
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * 0.7;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document.querySelector('a[aria-label="Back to title"]').click();
    });
    await reader.waitForFunction(() => document.body.innerText.includes('Chapters'));
    await reader.waitForNetworkIdle();
    assert.ok(progressRequests.some((progress) => progress.chapterId === 'chapter-1' && progress.position > 0.65 && progress.position < 0.75), 'leaving before debounce lost the current chapter position');
    await reader.evaluate(() => [...document.querySelectorAll('a')].find((node) => node.href.includes('chapterId=chapter-2'))?.click());
    await reader.waitForFunction(() => document.querySelector('h1')?.textContent === 'Second Light');
    const nextPosition = await reader.evaluate(() => document.querySelector('[data-lenis-prevent]').scrollTop);
    assert.ok(nextPosition < 10, `the next chapter inherited the previous reader position (${nextPosition}px)`);
  } finally { await secondDevice.close(); }
  console.log(`Novel browser fixture passed: discover → filters/page 2 → title → reader → download → cold offline reload → account isolation.`);
  console.log(`Screenshots: ${artifacts}/task-3-novel-*.png`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
