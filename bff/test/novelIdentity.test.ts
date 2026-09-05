import test from 'node:test';
import assert from 'node:assert/strict';
import { novelId, chapterId } from '../src/lib/novels/identity';
import { archivePath } from '../src/lib/novels/archive';

test('identity is stable, source-scoped and preserves meaningful path differences', () => {
  const id = novelId('source', '/book');
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(novelId('source', '/book'), id);
  assert.notEqual(novelId('other', '/book'), id);
  assert.notEqual(novelId('source', '/Book'), id);
  assert.notEqual(novelId('source', '/book?edition=1'), id);
  assert.notEqual(novelId('ab', 'c'), novelId('a', 'bc'));
  assert.notEqual(chapterId(id, '/chapter'), chapterId(novelId('other', '/book'), '/chapter'));
});

test('empty/control identities and archive traversal are rejected', () => {
  for (const value of ['', '  ', 'bad\u0000path']) assert.throws(() => novelId('source', value));
  assert.throws(() => novelId('', '/book'));
  assert.throws(() => chapterId('../escape', '/chapter'));
  for (const value of ['../escape', '/absolute', 'a'.repeat(63), 'z'.repeat(64)]) {
    assert.throws(() => archivePath('/tmp/novels', value));
  }
});
