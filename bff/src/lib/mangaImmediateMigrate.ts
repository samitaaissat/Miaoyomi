import { pool } from './db';

/** Source provenance for CBZs created by the one-chapter "Read now" flow. */
export async function migrateMangaImmediate(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('miaoyomi-manga-immediate-schema'))");
    await c.query(`
      CREATE TABLE IF NOT EXISTS manga_source_books (
        source_id text NOT NULL,
        source_series_id text NOT NULL,
        source_chapter_id text NOT NULL,
        book_id text NOT NULL REFERENCES lib_books(id) ON DELETE CASCADE,
        series_folder text NOT NULL,
        archive_file text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, source_series_id, source_chapter_id),
        UNIQUE (book_id)
      );
      CREATE INDEX IF NOT EXISTS manga_source_books_series
        ON manga_source_books (source_id, source_series_id);
    `);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
