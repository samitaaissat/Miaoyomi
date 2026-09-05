import { pool } from '../db';

/** Metadata only. Reading content belongs exclusively to the EPUB archive. */
export async function migrateNovels(): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT pg_advisory_xact_lock(hashtext('miaoyomi-novel-schema'))");
    await c.query(`
      CREATE TABLE IF NOT EXISTS novel_series (
        id text PRIMARY KEY, source_id text NOT NULL, source_path text NOT NULL,
        source_url text NOT NULL, title text NOT NULL, language text NOT NULL,
        author text, summary text, cover text, total_pages integer,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(source_id, source_path)
      );
      CREATE TABLE IF NOT EXISTS novel_chapters (
        id text PRIMARY KEY, novel_id text NOT NULL REFERENCES novel_series(id) ON DELETE CASCADE,
        source_path text NOT NULL, source_url text NOT NULL, title text NOT NULL,
        chapter_number double precision, position integer NOT NULL, saved boolean NOT NULL DEFAULT false,
        UNIQUE(novel_id, source_path)
      );
      CREATE INDEX IF NOT EXISTS novel_chapters_order ON novel_chapters(novel_id, position);
      CREATE TABLE IF NOT EXISTS novel_chapter_pages (
        novel_id text NOT NULL REFERENCES novel_series(id) ON DELETE CASCADE,
        source_page text NOT NULL, position_offset integer NOT NULL,
        PRIMARY KEY(novel_id, source_page)
      );
      CREATE TABLE IF NOT EXISTS novel_user_library (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        novel_id text NOT NULL REFERENCES novel_series(id) ON DELETE CASCADE,
        in_library boolean NOT NULL DEFAULT false, accessed_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(user_id, novel_id)
      );
      CREATE TABLE IF NOT EXISTS novel_progress (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        novel_id text NOT NULL REFERENCES novel_series(id) ON DELETE CASCADE,
        chapter_id text NOT NULL REFERENCES novel_chapters(id) ON DELETE CASCADE,
        position double precision NOT NULL CHECK(position BETWEEN 0 AND 1),
        completed boolean NOT NULL DEFAULT false, updated_at bigint NOT NULL, mutation_id text NOT NULL,
        PRIMARY KEY(user_id, chapter_id)
      );
      CREATE INDEX IF NOT EXISTS novel_progress_recent ON novel_progress(user_id, novel_id, updated_at DESC);
    `);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
