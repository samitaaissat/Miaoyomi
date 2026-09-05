import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFilters, serializeFilters, setExcludableValue } from '../lib/novels/filters';
import { novelBrowseUrl, novelDetailUrl } from '../lib/novels/client';
import { sanitizeNovelHtml } from '../lib/novels/content';

test('published plugin filter definitions retain their runtime type and value shape', () => {
  const definitions = normalizeFilters({
    keyword: { type: 'Text', label: 'Keyword', value: '' },
    orderBy: { type: 'Picker', label: 'Order', value: 'views', options: [{ label: 'Views', value: 'views' }, { label: 'Rating', value: 'rating' }] },
    completed: { type: 'Switch', label: 'Completed', value: false },
    genres: { type: 'XCheckbox', label: 'Genres', value: { include: [], exclude: [] }, options: [{ label: 'Fantasy', value: 'fantasy' }] },
  });
  assert.deepEqual(definitions.map((item) => [item.key, item.type]), [
    ['keyword', 'Text'], ['orderBy', 'Picker'], ['completed', 'Switch'], ['genres', 'XCheckbox'],
  ]);
  const values = Object.fromEntries(definitions.map((item) => [item.key, item.value]));
  values.orderBy = 'rating';
  values.genres = setExcludableValue(values.genres, 'fantasy', 'exclude');
  assert.deepEqual(serializeFilters(definitions, values), {
    keyword: { type: 'Text', value: '' },
    orderBy: { type: 'Picker', value: 'rating' },
    completed: { type: 'Switch', value: false },
    genres: { type: 'XCheckbox', value: { include: [], exclude: ['fantasy'] } },
  });
});

test('include/exclude filter choices are mutually exclusive and can be cleared', () => {
  let value: unknown = { include: ['fantasy'], exclude: [] };
  value = setExcludableValue(value, 'fantasy', 'exclude');
  assert.deepEqual(value, { include: [], exclude: ['fantasy'] });
  value = setExcludableValue(value, 'fantasy', 'ignore');
  assert.deepEqual(value, { include: [], exclude: [] });
});

test('browse and title URLs follow the static query-route contract', () => {
  assert.equal(
    novelBrowseUrl('royal road', 'latest', 2, { orderBy: { type: 'Picker', value: 'rating' } }),
    '/api/novels/browse?sourceId=royal+road&mode=latest&page=2&filters=%7B%22orderBy%22%3A%7B%22type%22%3A%22Picker%22%2C%22value%22%3A%22rating%22%7D%7D',
  );
  assert.equal(novelDetailUrl({ sourceId: 'ao3', path: '/works/42' }), '/api/novels/detail?sourceId=ao3&path=%2Fworks%2F42');
  assert.equal(novelDetailUrl({ id: 'saved-42' }), '/api/novels/saved-42');
});

test('reader content drops active and source-styled markup', () => {
  const clean = sanitizeNovelHtml('<style>body{display:none}</style><script>alert(1)</script><p style="color:red" onclick="alert(2)">Safe <img src="https://tracker.test/x"></p>');
  assert.equal(clean, '<p>Safe <img></p>');
});
