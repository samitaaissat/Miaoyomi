/**
 * Deterministic full-stack fixture for web/test/e2e/manga-immediate.mjs.
 *
 * The caller supplies an isolated DATABASE_URL and filesystem roots. This process uses the real auth,
 * source, downloader, scanner, catalog, image, offline-download, and static-web routes.
 */
import { rm, mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import sharp from 'sharp';
import { hash } from '@node-rs/argon2';

async function main() {
const port = Number(process.env.PORT || 58182);
const fixtureRoot = process.env.MANGA_BROWSER_ROOT || '/tmp/miaoyomi-browser-manga';
await rm(fixtureRoot, { recursive: true, force: true });
await Promise.all([
  mkdir(process.env.LIBRARY_ROOT!, { recursive: true }),
  mkdir(process.env.DL_ROOT!, { recursive: true }),
  mkdir(process.env.CONFIG_DIR!, { recursive: true }),
]);

// Keep the fixture deterministic: Discover and the series art fallback may ask AniList while the source
// chapter itself intentionally uses localhost and the real downloader network path.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'https://graphql.anilist.co') {
    return Promise.resolve(new Response(JSON.stringify({ data: { Page: { media: [] }, Media: null } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
  }
  return nativeFetch(input, init);
}) as typeof fetch;

const { migrate } = await import('../../src/lib/migrate');
const { migrateMangaImmediate } = await import('../../src/lib/mangaImmediateMigrate');
const { q, pool } = await import('../../src/lib/db');
const { registerAdapter } = await import('../../src/lib/sources');
const authRoutes = (await import('../../src/routes/auth')).default;
const catalogRoutes = (await import('../../src/routes/catalog')).default;
const imageRoutes = (await import('../../src/routes/images')).default;
const personalRoutes = (await import('../../src/routes/personal')).default;
const downloadRoutes = (await import('../../src/routes/downloads')).default;
const sourceRoutes = (await import('../../src/routes/sources')).default;
const { registerWebRoot } = await import('../../src/lib/webRoot');

await migrate();
await migrateMangaImmediate();
const password = 'Manga-browser-123!';
const username = 'manga-browser';
await q('DELETE FROM users WHERE username = $1', [username]);
const priorSeries = await q<{ series_id: string }>(
  `SELECT DISTINCT b.series_id FROM manga_source_books m
   JOIN lib_books b ON b.id = m.book_id WHERE m.source_id = 'browser-manga'`,
);
await q(`DELETE FROM manga_source_books WHERE source_id = 'browser-manga'`);
if (priorSeries.length) {
  await q('DELETE FROM lib_series WHERE id = ANY($1)', [priorSeries.map((row) => row.series_id)]);
}
await q(`DELETE FROM source_health WHERE source_id = 'browser-manga'`);
const user = (await q<{ id: string }>(
  `INSERT INTO users (username, display_name, password_hash, role, auth_kind, perms)
   VALUES ($1, 'Manga Browser', $2, 'admin', 'password', '{"canDownload":true}') RETURNING id`,
  [username, await hash(password)],
))[0];
await q(`INSERT INTO app_settings (user_id, data) VALUES ($1, '{"locale":"en"}')`, [user.id]);

const calls: string[] = [];
const series = {
  sourceId: 'browser-series', source: 'browser-manga', title: 'Prismatic Fixture',
  summary: 'A deterministic title with two independent chapter-seven translations.',
  genres: ['Fixture'], status: 'Ongoing',
};
const chapters = [
  { sourceId: 'chapter-7-en', number: 7, title: 'Seven in English', lang: 'en', pages: 2 },
  { sourceId: 'chapter-7-fr', number: 7, title: 'Sept en français', lang: 'fr', pages: 2 },
  { sourceId: 'chapter-8', number: 8, title: 'Eight', lang: 'en', pages: 2 },
];
registerAdapter({
  id: 'browser-manga', name: 'Browser Fixture', lang: 'en', preferredOrder: 0,
  async search() { return [series]; },
  async latest() { return [series]; },
  async popular() { return [series]; },
  async getSeries(id: string) { return id === series.sourceId ? series : null; },
  async listChapters(id: string) { return id === series.sourceId ? chapters : []; },
  async getPageUrls(chapterId: string) {
    calls.push(chapterId);
    return [1, 2].map((n) => `http://127.0.0.1:${port}/__fixture/page/${encodeURIComponent(chapterId)}/${n}.png`);
  },
});

const app = Fastify({ logger: false });
await app.register(cookie);
await app.register(jwt, { secret: process.env.JWT_SECRET! });
await app.register(rateLimit, { global: false });

app.get('/__fixture/state', async () => {
  const mappings = await q(
    `SELECT source_chapter_id, book_id, archive_file FROM manga_source_books
      WHERE source_id = 'browser-manga' ORDER BY source_chapter_id`,
  );
  return { calls, mappings };
});
app.get('/__fixture/page/:chapter/:page.png', async (req, reply) => {
  const { chapter, page } = req.params as { chapter: string; page: string };
  if (!/^[a-z0-9-]+$/i.test(chapter) || !/^\d+$/.test(page)) return reply.code(400).send({ error: 'bad_fixture_page' });
  const color = chapter.endsWith('-fr') ? '#2563eb' : '#d946ef';
  const png = await sharp({
    create: { width: 720, height: 1080, channels: 4, background: color },
  }).composite([{
    input: Buffer.from(`<svg width="720" height="1080"><text x="360" y="520" text-anchor="middle" font-size="48" fill="white">${chapter} · page ${page}</text></svg>`),
  }]).png().toBuffer();
  return reply.type('image/png').send(png);
});

await app.register(authRoutes);
await app.register(catalogRoutes);
await app.register(imageRoutes);
await app.register(personalRoutes);
await app.register(downloadRoutes);
await app.register(sourceRoutes);
await registerWebRoot(app);
await app.listen({ host: '127.0.0.1', port });
console.log(JSON.stringify({ ready: true, port, username, password }));

const stop = async () => {
  await app.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
