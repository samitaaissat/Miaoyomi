import test from 'node:test';
import assert from 'node:assert/strict';
import { openSourceChapter, sourceChapterKey } from '../lib/mangaImmediate';

test('duplicate-number source chapters retain independent selection keys', () => {
  assert.notEqual(
    sourceChapterKey({ id: 'translation-a', number: 7 }),
    sourceChapterKey({ id: 'translation-b', number: 7 }),
  );
});

test('Read now posts the source identities and returns the server reader URL', async () => {
  const seen: Array<{ path: string; opts: unknown }> = [];
  const result = await openSourceChapter(
    { source: 'fixture', sourceId: 'series-id', chapterId: 'translation-b' },
    async (path, opts) => {
      seen.push({ path, opts });
      return { bookId: 'b_123', readerUrl: '/reader/?book=b_123', reused: false };
    },
  );
  assert.deepEqual(seen, [{
    path: '/api/sources/chapter/open',
    opts: { json: { source: 'fixture', sourceId: 'series-id', chapterId: 'translation-b' } },
  }]);
  assert.equal(result.readerUrl, '/reader/?book=b_123');
});
