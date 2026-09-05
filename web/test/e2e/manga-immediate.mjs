import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const bff = join(root, 'bff');
const artifacts = join(root, '.superpowers', 'sdd', '2026-09-05-miaoyomi');
const port = 58182;
const base = `http://127.0.0.1:${port}`;
const fixtureRoot = '/tmp/miaoyomi-browser-manga';
await mkdir(artifacts, { recursive: true });

const server = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/mangaBrowserServer.ts'], {
  cwd: bff,
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    PUBLIC_ORIGIN: base,
    DATABASE_URL: process.env.MANGA_BROWSER_DATABASE_URL
      || 'postgres://miaoyomi:miaoyomi-test@127.0.0.1:55433/miaoyomi_browser_manga',
    JWT_SECRET: 'manga-browser-secret-at-least-32-characters',
    LIBRARY_BACKEND: 'owned',
    LIBRARY_ROOT: `${fixtureRoot}/library`,
    DL_ROOT: `${fixtureRoot}/downloads`,
    CONFIG_DIR: `${fixtureRoot}/config`,
    CACHE_DIR: `${fixtureRoot}/cache`,
    WEB_ROOT: join(root, 'web', 'out'),
    MIN_FREE_GB: '0',
    DOWNLOAD_MIN_GAP_MS: '0',
    DOWNLOAD_PAGE_GAP_MS: '0',
    TZ: 'UTC',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let logs = '';
server.stdout.on('data', (chunk) => { logs += chunk; process.stdout.write(chunk); });
server.stderr.on('data', (chunk) => { logs += chunk; process.stderr.write(chunk); });
const waitForServer = () => new Promise((resolve, reject) => {
  const poll = setInterval(() => {
    if (logs.includes('"ready":true')) finish(resolve);
  }, 25);
  const timeout = setTimeout(() => finish(() => reject(new Error(`fixture server did not start:\n${logs}`))), 20_000);
  const finish = (done) => {
    clearInterval(poll);
    clearTimeout(timeout);
    done();
  };
});

let browser;
try {
  await waitForServer();
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || (existsSync(chrome) ? chrome : undefined);
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.error('Browser error:', error.message));
  await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 1 });
  await page.goto(`${base}/discover/`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('input[type="text"]');
  await page.type('input[type="text"]', 'manga-browser');
  await page.type('input[type="password"]', 'Manga-browser-123!');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => document.body.innerText.includes('Prismatic Fixture'));
  // Let the first-install controllerchange finish before testing controls. Clicking while that automatic
  // reload is replacing the document produces a real DOM click on a page that is already going away.
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForFunction(() => document.body.innerText.includes('Prismatic Fixture'));

  await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Prismatic Fixture'));
    if (!card) throw new Error('fixture source card not found');
    card.click();
  });
  await page.waitForSelector('[role="dialog"] select');
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.textContent?.includes('Read now'));
  const options = await page.$eval('[role="dialog"] select', (select) =>
    [...select.options].map((option) => ({ value: option.value, label: option.textContent?.trim() })),
  );
  assert.deepEqual(options.map((option) => option.value), ['chapter-7-en', 'chapter-7-fr', 'chapter-8']);
  assert.equal(options.filter((option) => option.label?.startsWith('Chapter 7')).length, 2,
    'the duplicate chapter numbers were collapsed in the dialog');
  await page.select('[role="dialog"] select:first-of-type', 'chapter-7-fr');
  await page.screenshot({ path: join(artifacts, 'task-5-manga-chapter-select.png'), fullPage: true });

  await page.evaluate(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find((node) => node.textContent?.trim() === 'Read now');
    if (!button) throw new Error('Read now button not found');
    button.click();
  });
  await page.waitForFunction(() => location.pathname === '/reader/' && new URLSearchParams(location.search).get('book')?.startsWith('b_'));
  const readerUrl = page.url();
  const bookId = new URL(readerUrl).searchParams.get('book');
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img[alt^="Page "]')];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  const onlinePages = await page.$$eval('img[alt^="Page "]', (images) =>
    images.map((image) => ({ alt: image.alt, width: image.naturalWidth, height: image.naturalHeight, src: image.src })),
  );
  assert.ok(onlinePages.every((image) => image.width === 720 && image.height === 1080));
  const readerChapterTitle = await page.$eval(
    'a[aria-label^="Open Prismatic Fixture series page"] p:last-child',
    (node) => node.textContent?.trim(),
  );
  assert.equal(readerChapterTitle, 'Sept en français · fr');
  assert.doesNotMatch(readerChapterTitle, /\[[0-9a-f]{16}\]/,
    'the image reader exposed the collision-safe archive identity hash');
  const state = await (await fetch(`${base}/__fixture/state`)).json();
  assert.deepEqual(state.calls, ['chapter-7-fr'], 'the browser flow downloaded a sibling chapter');
  assert.equal(state.mappings.length, 1);
  assert.equal(state.mappings[0].source_chapter_id, 'chapter-7-fr');
  assert.equal(state.mappings[0].book_id, bookId);
  await page.screenshot({ path: join(artifacts, 'task-5-manga-reader-online.png'), fullPage: true });

  await page.click('a[aria-label^="Open Prismatic Fixture series page"]');
  try {
    await page.waitForFunction(() => location.pathname === '/series/' && !!document.querySelector('button[aria-label="Download"]'), { timeout: 10_000 });
  } catch (error) {
    console.error('Series navigation:', page.url(), await page.evaluate(() => document.body.innerText));
    throw error;
  }
  await page.evaluate(() => document.querySelector('button[aria-label="Download"]')?.click());
  try {
    await page.waitForSelector('button[aria-label="Remove download"]', { timeout: 10_000 });
  } catch (error) {
    console.error('Offline control:', await page.evaluate(() => ({
      buttons: [...document.querySelectorAll('button')].map((button) => ({ aria: button.getAttribute('aria-label'), text: button.textContent?.trim() })).filter((x) => x.aria || x.text),
      body: document.body.innerText,
    })));
    throw error;
  }
  await page.screenshot({ path: join(artifacts, 'task-5-manga-series-offline-saved.png'), fullPage: true });

  // A real navigation gives the service worker an exact reader shell to cache. The chapter itself must then
  // come from account-scoped IndexedDB, which is shown by blob: page URLs after the cold offline reload.
  await page.goto(readerUrl, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => [...document.querySelectorAll('img[alt^="Page "]')]
    .every((image) => image.complete && image.naturalWidth > 0));
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll('img[alt^="Page "]')];
    return images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0 && image.src.startsWith('blob:'));
  }, { timeout: 15_000 });
  await page.screenshot({ path: join(artifacts, 'task-5-manga-reader-offline.png'), fullPage: true });

  console.log(`Manga browser fixture passed: Discover → chapter 7/fr → one CBZ → ${bookId} → image reader → saved offline → cold offline reader.`);
  console.log(`Screenshots: ${artifacts}/task-5-manga-*.png`);
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
}
