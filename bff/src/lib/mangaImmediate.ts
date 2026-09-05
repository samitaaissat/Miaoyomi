import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { downloadChapter, sanitize } from './downloader';
import { DL_ROOT, libraryIdFor, persistScan, type LibraryRow } from './library';
import { one, q } from './db';
import { Pool } from 'pg';
import { env } from '../env';
import type { SourceAdapter, SourceChapter, SourceSeries } from './sources';
import { Params, visible, type ViewCtx } from './visibility';

export class MangaImmediateError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

// Waiting chapter locks must never occupy the query connections their owners need to finish.
// Keep lock waiters in a separate bounded pool; idle connections do not keep CLI/tests alive.
const chapterLocks = new Pool({
  connectionString: env.DATABASE_URL,
  max: 4,
  idleTimeoutMillis: 1_000,
  allowExitOnIdle: true,
});

const digest = (value: string, length = 16): string =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

const safeComponent = (value: string): string =>
  sanitize(value).replace(/\.\.+/g, '_').replace(/^\.+/, '').replace(/[. ]+$/, '').trim() || 'untitled';

function generatedFolder(adapter: SourceAdapter, series: SourceSeries): string {
  const sourceKey = digest(adapter.id, 10);
  const seriesKey = digest(`${adapter.id}\0${series.sourceId}`);
  // The hash is the identity. The labels make a server-side library understandable without making a
  // remote title (or two equal titles from different sources) part of that identity.
  return `Source manga/${safeComponent(adapter.name)} [${sourceKey}]/${safeComponent(series.title)} [${seriesKey}]`;
}

function archiveName(chapter: SourceChapter, adapter: SourceAdapter, sourceSeriesId: string): string {
  if (!Number.isFinite(chapter.number)) throw new MangaImmediateError(422, 'invalid_chapter', 'The source returned an invalid chapter number.');
  return `Chapter ${chapter.number} [${digest(`${adapter.id}\0${sourceSeriesId}\0${chapter.sourceId}`)}].cbz`;
}

function displayTitle(chapter: SourceChapter): string {
  const title = chapter.title?.replace(/\s+/g, ' ').trim() || `Chapter ${chapter.number}`;
  const language = chapter.lang?.replace(/\s+/g, ' ').trim();
  return language ? `${title} · ${language}` : title;
}

async function seedDisplayTitle(bookId: string, chapter: SourceChapter): Promise<void> {
  // The archive hash remains the collision-safe filesystem identity. Seed the source label through the
  // catalog's existing override seam, and never replace a title (or number) the reader edited later.
  await q(
    `INSERT INTO book_overrides (book_id, title) VALUES ($1, $2)
     ON CONFLICT (book_id) DO NOTHING`,
    [bookId, displayTitle(chapter)],
  );
}

interface MappingRow {
  book_id: string;
  file: string;
  root: string;
  library_id: string;
  series_folder: string;
  can_view: boolean;
  deleted_at: string | null;
  merged_into: string | null;
}

function mayUseLibrary(ctx: ViewCtx, libraryId: string): boolean {
  return ctx.libraryIds === null || ctx.libraryIds.includes(libraryId);
}

async function mappedBook(
  adapterId: string,
  seriesId: string,
  chapterId: string,
  ctx: ViewCtx,
): Promise<MappingRow | null> {
  const params = new Params();
  const source = params.add(adapterId), series = params.add(seriesId), chapter = params.add(chapterId);
  const row = await one<MappingRow>(
    `SELECT m.book_id, b.file, b.root, s.library_id, m.series_folder,
            s.deleted_at, s.merged_into, (${visible('s', ctx, params)}) AS can_view
       FROM manga_source_books m
       JOIN lib_books b ON b.id = m.book_id
       JOIN lib_series s ON s.id = b.series_id
      WHERE m.source_id = ${source} AND m.source_series_id = ${series} AND m.source_chapter_id = ${chapter}`,
    params.values,
  );
  if (!row || row.deleted_at || row.merged_into) return null;
  if (!row.can_view) {
    throw new MangaImmediateError(403, 'forbidden', 'This chapter is unavailable on this account.');
  }
  if (await stat(`${row.root}/${row.file}`).then(() => true).catch(() => false)) return row;
  // The mapping is authoritative only while the standard archive exists. The scanner deliberately keeps
  // missing rows, so remove provenance and let the exact same path be rebuilt below.
  await q(
    'DELETE FROM manga_source_books WHERE source_id = $1 AND source_series_id = $2 AND source_chapter_id = $3',
    [adapterId, seriesId, chapterId],
  );
  return null;
}

async function folderFor(adapter: SourceAdapter, series: SourceSeries): Promise<string> {
  const prior = await one<{ series_folder: string }>(
    `SELECT series_folder FROM manga_source_books
      WHERE source_id = $1 AND source_series_id = $2 ORDER BY created_at LIMIT 1`,
    [adapter.id, series.sourceId],
  );
  return prior?.series_folder || generatedFolder(adapter, series);
}

async function intendedLibrary(folder: string, ctx: ViewCtx): Promise<string> {
  const params = new Params();
  const folderParam = params.add(folder);
  const existing = await one<{ library_id: string; deleted_at: string | null; merged_into: string | null; can_view: boolean }>(
    `SELECT s.library_id, s.deleted_at, s.merged_into, (${visible('s', ctx, params)}) AS can_view
       FROM lib_series s WHERE s.folder = ${folderParam}`, params.values,
  );
  if (existing?.deleted_at) {
    throw new MangaImmediateError(409, 'series_deleted', 'This series is in the library trash. Restore it before opening a source chapter.');
  }
  if (existing?.merged_into) {
    const targetParams = new Params();
    const targetId = targetParams.add(existing.merged_into);
    const target = await one<{ library_id: string }>(
      `SELECT s.library_id FROM lib_series s WHERE s.id = ${targetId} AND ${visible('s', ctx, targetParams)}`,
      targetParams.values,
    );
    if (!target) throw new MangaImmediateError(403, 'forbidden', 'This chapter is unavailable on this account.');
    return target.library_id;
  }
  if (existing) {
    if (!existing.can_view) throw new MangaImmediateError(403, 'forbidden', 'This chapter is unavailable on this account.');
    return existing.library_id;
  }
  const libs = await q<LibraryRow & { age_rating: number | null }>('SELECT id, path, age_rating FROM libraries ORDER BY length(path) DESC');
  const libraryId = libraryIdFor(folder, libs);
  const age = libs.find((library) => library.id === libraryId)?.age_rating;
  if (ctx.maxAgeRating !== null && age != null && age > ctx.maxAgeRating) {
    throw new MangaImmediateError(403, 'forbidden', 'This library is unavailable on this account.');
  }
  return libraryId;
}

export interface OpenMangaChapterInput {
  adapter: SourceAdapter;
  series: SourceSeries;
  chapter: SourceChapter;
  viewCtx: ViewCtx;
}

export interface OpenMangaChapterResult {
  bookId: string;
  readerUrl: string;
  reused: boolean;
}

/** Download exactly one source chapter, persist its CBZ, and return the image reader's real book id. */
export async function openMangaChapter(input: OpenMangaChapterInput): Promise<OpenMangaChapterResult> {
  const { adapter, series, chapter, viewCtx } = input;
  if (!series.sourceId || !chapter.sourceId || series.sourceId.includes('\0') || chapter.sourceId.includes('\0')) {
    throw new MangaImmediateError(422, 'invalid_source_data', 'The source returned an incomplete chapter identity.');
  }

  // A session advisory lock is the cross-process counterpart to the downloader's in-process source gate.
  // It covers the provenance check, atomic CBZ write, scan, and mapping insert as one logical operation.
  const c = await chapterLocks.connect();
  // Hash before binding: PostgreSQL text rejects NUL and source ids are otherwise unconstrained strings.
  const lockA = digest(`${adapter.id}\0${series.sourceId}`, 32);
  const lockB = digest(chapter.sourceId, 32);
  try {
    await c.query('SELECT pg_advisory_lock(hashtext($1), hashtext($2))', [lockA, lockB]);
    const mapped = await mappedBook(adapter.id, series.sourceId, chapter.sourceId, viewCtx);
    if (mapped) {
      await seedDisplayTitle(mapped.book_id, chapter);
      return { bookId: mapped.book_id, readerUrl: `/reader/?book=${mapped.book_id}`, reused: true };
    }

    const folder = await folderFor(adapter, series);
    const libraryId = await intendedLibrary(folder, viewCtx);
    if (!mayUseLibrary(viewCtx, libraryId)) {
      throw new MangaImmediateError(403, 'forbidden', 'This account cannot add chapters to that library.');
    }

    const downloaded = await downloadChapter({
      sourceId: adapter.id,
      seriesFolder: folder,
      chapter,
      archiveName: archiveName(chapter, adapter, series.sourceId),
      meta: {
        series: series.title,
        summary: series.summary,
        author: series.author,
        genres: series.genres,
        url: series.url,
        status: series.status,
      },
    });
    await persistScan();

    const book = await one<{ id: string; series_id: string }>(
      'SELECT id, series_id FROM lib_books WHERE root = $1 AND file = $2',
      [DL_ROOT, downloaded.file],
    );
    if (!book) throw new Error('downloaded chapter was not indexed by the library scanner');

    await q(
      `INSERT INTO manga_source_books
         (source_id, source_series_id, source_chapter_id, book_id, series_folder, archive_file)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_id, source_series_id, source_chapter_id) DO UPDATE SET
         book_id = EXCLUDED.book_id, series_folder = EXCLUDED.series_folder,
         archive_file = EXCLUDED.archive_file, updated_at = now()`,
      [adapter.id, series.sourceId, chapter.sourceId, book.id, folder, downloaded.file],
    );
    if (chapter.publishedAt) {
      await q('UPDATE lib_books SET published_at = $2::timestamptz WHERE id = $1', [book.id, chapter.publishedAt]);
    }
    await seedDisplayTitle(book.id, chapter);
    return { bookId: book.id, readerUrl: `/reader/?book=${book.id}`, reused: !!downloaded.skipped };
  } finally {
    await c.query('SELECT pg_advisory_unlock(hashtext($1), hashtext($2))', [lockA, lockB]).catch(() => {});
    c.release();
  }
}
