import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DSN = process.env.TEST_DATABASE_URL;
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
const ROOT = mkdtempSync(join(tmpdir(), 'miaoyomi-immediate-'));
const LIBRARY = join(ROOT, 'library');
const DOWNLOADS = join(ROOT, 'downloads');

if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-16-chars';
  process.env.CONFIG_DIR = join(ROOT, 'config');
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = LIBRARY;
  process.env.DL_ROOT = DOWNLOADS;
  process.env.MIN_FREE_GB = '0';
  process.env.DOWNLOAD_MIN_GAP_MS = '0';
  process.env.DOWNLOAD_PAGE_GAP_MS = '0';
  process.env.TZ = 'UTC';
}

const SOURCE = 'task5-fixture';
const SERIES = 'series/../../unsafe';
const USERS = ['task5-reader', 'task5-no-download'];
const calls: string[] = [];
let imageServer: Server;
let imageUrl = '';
let app: any;
let q: <T = any>(sql: string, params?: any[]) => Promise<T[]>;
let dbPool: { end(): Promise<void> };
let ids: Record<string, string>;

async function cbzFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.cbz$/i.test(entry.name)) out.push(path);
    }
  };
  await walk(dir);
  return out;
}

before(async () => {
  if (!DSN) return;
  const sharp = (await import('sharp')).default;
  const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#d946ef' } })
    .png({ compressionLevel: 0 }).toBuffer();
  imageServer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
  });
  await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const address = imageServer.address();
  imageUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/page.png`;

  const { migrate } = await import('../src/lib/migrate');
  const { migrateMangaImmediate } = await import('../src/lib/mangaImmediateMigrate');
  ({ q, pool: dbPool } = await import('../src/lib/db'));
  const { registerAdapter } = await import('../src/lib/sources');
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  const sourceRoutes = (await import('../src/routes/sources')).default;
  const catalogRoutes = (await import('../src/routes/catalog')).default;
  await migrate();
  await migrateMangaImmediate();

  registerAdapter({
    id: SOURCE,
    name: 'Fixture / Unsafe:*? Source',
    async search() { return []; },
    async getSeries(sourceId: string) {
      return { sourceId, source: SOURCE, title: '../../Unsafe: Series?', summary: 'fixture' };
    },
    async listChapters(seriesId: string) {
      if (seriesId === 'unavailable') throw new Error('remote service refused the request');
      return [
        { sourceId: 'duplicate-a', number: 7, title: 'first translation', lang: 'en' },
        { sourceId: 'duplicate-b', number: 7, title: 'second translation', lang: 'fr' },
        { sourceId: 'sibling', number: 8, title: 'sibling' },
      ];
    },
    async getPageUrls(chapterId: string) { calls.push(chapterId); return [imageUrl]; },
  });

  await q('DELETE FROM users WHERE username = ANY($1)', [USERS]);
  const makeUser = async (username: string, perms: Record<string, unknown>) => (await q<{ id: string }>(
    `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
     VALUES ($1,$1,'x','user','password',$2) RETURNING id`,
    [username, JSON.stringify(perms)],
  ))[0].id;
  ids = {
    reader: await makeUser(USERS[0], {}),
    denied: await makeUser(USERS[1], { canDownload: false }),
  };

  app = Fastify();
  await app.register(jwt, { secret: process.env.JWT_SECRET! });
  await app.register(sourceRoutes);
  await app.register(catalogRoutes);
  await app.ready();
});

after(async () => {
  if (DSN) {
    const ownSeries = await q<{ series_id: string }>(
      `SELECT DISTINCT b.series_id FROM manga_source_books m
       JOIN lib_books b ON b.id = m.book_id WHERE m.source_id = $1`, [SOURCE],
    ).catch(() => []);
    await q('DELETE FROM manga_source_books WHERE source_id = $1', [SOURCE]).catch(() => {});
    if (ownSeries.length) {
      await q('DELETE FROM lib_series WHERE id = ANY($1)', [ownSeries.map((row) => row.series_id)]).catch(() => {});
    }
    await q('DELETE FROM user_libraries WHERE user_id = ANY($1)', [Object.values(ids || {})]).catch(() => {});
    await q('DELETE FROM users WHERE username = ANY($1)', [USERS]).catch(() => {});
    await q('DELETE FROM source_health WHERE source_id = $1', [SOURCE]).catch(() => {});
    await app?.close().catch(() => {});
    await new Promise<void>((resolve) => imageServer.close(() => resolve()));
    await dbPool?.end().catch(() => {});
  }
  await rm(ROOT, { recursive: true, force: true });
});

const token = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id, role: 'user' })}` });

test('source detail exposes stable chapter identities, including duplicate numbers', { skip }, async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/sources/detail?source=${SOURCE}&sourceId=${encodeURIComponent(SERIES)}`,
    headers: token(ids.reader),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().chapters.map((c: any) => [c.id, c.number]), [
    ['duplicate-a', 7], ['duplicate-b', 7], ['sibling', 8],
  ]);
});

test('selected chapter becomes one safe CBZ and resolves to the scanner book id', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.match(body.bookId, /^b_[0-9a-f]{20}$/);
  assert.equal(body.readerUrl, `/reader/?book=${body.bookId}`);
  assert.deepEqual(calls, ['duplicate-b'], 'a sibling or same-number translation was downloaded');

  const files = await cbzFiles(DOWNLOADS);
  assert.equal(files.length, 1, `expected one CBZ, found ${files.join(', ')}`);
  assert.ok(files[0].startsWith(DOWNLOADS + '/'));
  assert.equal(files[0].includes('..'), false, `unsafe path survived sanitising: ${files[0]}`);
  const rows = await q<{ id: string; file: string; root: string }>(
    'SELECT id, file, root FROM lib_books WHERE id = $1', [body.bookId],
  );
  assert.equal(rows.length, 1, 'returned an id that is not an actual scanner book');
  assert.equal(join(rows[0].root, rows[0].file), files[0]);
  const readerBook = await app.inject({ method: 'GET', url: `/api/books/${body.bookId}`, headers: token(ids.reader) });
  assert.equal(readerBook.statusCode, 200, readerBook.body);
  assert.equal(readerBook.json().id, body.bookId);
  assert.equal(readerBook.json().metadata.title, 'second translation · fr',
    'the reader exposed the collision-safe archive filename instead of the source chapter title');
  const readerPages = await app.inject({ method: 'GET', url: `/api/books/${body.bookId}/pages`, headers: token(ids.reader) });
  assert.equal(readerPages.statusCode, 200, readerPages.body);
  assert.equal(readerPages.json().length, 1, 'the image reader did not see the downloaded PNG');

  const again = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().bookId, body.bookId, 'provenance-backed reuse minted a new reader book');
  assert.deepEqual(calls, ['duplicate-b'], 'reuse fetched the chapter again');
  assert.equal((await cbzFiles(DOWNLOADS)).length, 1, 'reuse wrote another CBZ');

  await q(
    `INSERT INTO book_overrides (book_id, title) VALUES ($1, 'My chapter label')
     ON CONFLICT (book_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now()`,
    [body.bookId],
  );
  const reusedAfterEdit = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
  });
  assert.equal(reusedAfterEdit.statusCode, 200, reusedAfterEdit.body);
  const editedBook = await app.inject({ method: 'GET', url: `/api/books/${body.bookId}`, headers: token(ids.reader) });
  assert.equal(editedBook.json().metadata.title, 'My chapter label', 'reuse replaced a manual chapter title');

  await rm(files[0]);
  const rebuilt = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
  });
  assert.equal(rebuilt.statusCode, 200, rebuilt.body);
  assert.equal(rebuilt.json().bookId, body.bookId, 'archive rebuild minted a new reader book');
  assert.deepEqual(calls, ['duplicate-b', 'duplicate-b'], 'archive rebuild did not fetch exactly its source chapter');
  const rebuiltBook = await app.inject({ method: 'GET', url: `/api/books/${body.bookId}`, headers: token(ids.reader) });
  assert.equal(rebuiltBook.json().metadata.title, 'My chapter label', 'archive rebuild replaced a manual chapter title');
  assert.equal((await cbzFiles(DOWNLOADS)).length, 1, 'archive rebuild wrote a duplicate CBZ');
});

test('membership, download permission, and unknown chapter fail before page download', { skip }, async () => {
  const beforeCalls = calls.length;
  await q(`INSERT INTO user_libraries (user_id, library_id) VALUES ($1, 'task5-no-library')`, [ids.reader]);
  try {
    const hidden = await app.inject({
      method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
      payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-a' },
    });
    assert.equal(hidden.statusCode, 403, hidden.body);
  } finally {
    await q('DELETE FROM user_libraries WHERE user_id = $1', [ids.reader]);
  }

  const denied = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.denied),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-a' },
  });
  assert.equal(denied.statusCode, 403, denied.body);

  await q(
    `INSERT INTO source_health (source_id, disabled) VALUES ($1, true)
     ON CONFLICT (source_id) DO UPDATE SET disabled = true`, [SOURCE],
  );
  try {
    const unavailable = await app.inject({
      method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
      payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-a' },
    });
    assert.equal(unavailable.statusCode, 409, unavailable.body);
  } finally {
    await q('UPDATE source_health SET disabled = false WHERE source_id = $1', [SOURCE]);
  }

  const missing = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: SERIES, chapterId: 'not-a-chapter' },
  });
  assert.equal(missing.statusCode, 404, missing.body);
  assert.equal(calls.length, beforeCalls, 'a refusal still reached getPageUrls');
});

test('chapter locking leaves the shared query pool usable under concurrent load', { skip }, async () => {
  const { pool } = await import('../src/lib/db');
  const reserved = await Promise.all(Array.from({ length: 9 }, () => pool.connect()));
  const previousTimeout = pool.options.connectionTimeoutMillis;
  pool.options.connectionTimeoutMillis = 150;
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
      payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().reused, true);
  } finally {
    pool.options.connectionTimeoutMillis = previousTimeout;
    reserved.forEach((client) => client.release());
  }
});

test('failed chapter lookup is an explicit error rather than an empty chapter list', { skip }, async () => {
  const initialCalls = calls.length;
  for (const route of ['detail', 'chapters']) {
    const response = await app.inject({
      method: 'GET', url: `/api/sources/${route}?source=${SOURCE}&sourceId=unavailable`, headers: token(ids.reader),
    });
    assert.equal(response.statusCode, 502, response.body);
    assert.equal(response.json().error, 'source_unavailable');
  }
  const response = await app.inject({
    method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
    payload: { source: SOURCE, sourceId: 'unavailable', chapterId: 'duplicate-b' },
  });
  assert.equal(response.statusCode, 502, response.body);
  assert.equal(calls.length, initialCalls);
});

test('soft-deleted source series does not return an unreadable book as success', { skip }, async () => {
  const rows = await q<{ series_id: string }>(
    `SELECT b.series_id FROM manga_source_books m JOIN lib_books b ON b.id = m.book_id
     WHERE m.source_id = $1 LIMIT 1`, [SOURCE],
  );
  await q('UPDATE lib_series SET deleted_at = now() WHERE id = $1', [rows[0].series_id]);
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
      payload: { source: SOURCE, sourceId: SERIES, chapterId: 'duplicate-b' },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'series_deleted');
  } finally {
    await q('UPDATE lib_series SET deleted_at = NULL WHERE id = $1', [rows[0].series_id]);
  }
});

test('source-open respects the same series age cap as the image reader', { skip }, async () => {
  const rows = await q<{ series_id: string }>(
    `SELECT b.series_id FROM manga_source_books m JOIN lib_books b ON b.id = m.book_id
     WHERE m.source_id = $1 LIMIT 1`, [SOURCE],
  );
  const initialCalls = calls.length;
  await q('UPDATE lib_series SET age_rating = 18 WHERE id = $1', [rows[0].series_id]);
  await q('UPDATE users SET max_age_rating = 12 WHERE id = $1', [ids.reader]);
  try {
    for (const chapterId of ['duplicate-b', 'duplicate-a']) {
      const response = await app.inject({
        method: 'POST', url: '/api/sources/chapter/open', headers: token(ids.reader),
        payload: { source: SOURCE, sourceId: SERIES, chapterId },
      });
      assert.equal(response.statusCode, 403, response.body);
    }
    assert.equal(calls.length, initialCalls);
  } finally {
    await q('UPDATE lib_series SET age_rating = NULL WHERE id = $1', [rows[0].series_id]);
    await q('UPDATE users SET max_age_rating = NULL WHERE id = $1', [ids.reader]);
  }
});
