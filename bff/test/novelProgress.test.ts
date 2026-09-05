import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeNovelProgress } from '../src/lib/novels/progress';

const stamp = 1_800_000_000_000;
const at = (position: number, updatedAt: number, completed = false) => ({
  chapterId: 'c'.repeat(64), position, completed, updatedAt, mutationId: `device-${updatedAt}`,
});

test('a delayed offline update cannot replace a newer reading position', () => {
  const result = mergeNovelProgress(at(.8, stamp), at(.2, stamp - 1000), stamp);
  assert.equal(result.position, .8);
  assert.equal(result.updatedAt, stamp);
});

test('chapter completion survives an unfinished reread and a delayed completed event is retained', () => {
  assert.equal(mergeNovelProgress(at(1, stamp, true), at(.2, stamp + 1000), stamp + 1000).completed, true);
  assert.equal(mergeNovelProgress(at(.8, stamp), at(1, stamp - 1000, true), stamp).completed, true);
});

test('a fresh intentional reread can move position while completion remains independent', () => {
  const result = mergeNovelProgress(at(1, stamp, true), at(.1, stamp + 1000), stamp + 1000);
  assert.equal(result.position, .1);
  assert.equal(result.completed, true);
});

test('invalid or future clock values cannot lock progress permanently', () => {
  assert.equal(mergeNovelProgress(null, at(.3, stamp + 86400000), stamp).updatedAt, stamp);
  for (const bad of [NaN, Infinity, -1, 1.01]) {
    assert.throws(() => mergeNovelProgress(null, at(bad, stamp), stamp), /position/);
  }
  assert.throws(() => mergeNovelProgress(null, at(.3, NaN), stamp), /timestamp/);
});

test('different chapter state cannot be combined accidentally', () => {
  assert.throws(() => mergeNovelProgress(at(.8, stamp), {...at(.2, stamp + 1), chapterId:'other'}, stamp), /chapter/);
});
