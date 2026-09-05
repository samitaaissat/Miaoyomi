import 'fake-indexeddb/auto';
import test, { before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDB } from 'idb';
import type { NovelPayload as ServerNovelPayload } from '../../bff/src/lib/novels/apiTypes';

const A = 'novel-reader-a';
const B = 'novel-reader-b';

let storage: typeof import('../lib/novels/storage');
let setCurrentUser: typeof import('../lib/api').setCurrentUser;

const payload = (chapterId = 'chapter-1'): ServerNovelPayload => ({
  novelId: 'novel-1', chapterId, novelTitle: 'The Glass Orchard',
  chapterTitle: chapterId === 'chapter-1' ? 'A Door in Winter' : 'Second Light',
  html: '<p>The orchard waited under snow.</p>', sourceUrl: 'https://fiction.test/chapter-1',
  archiveRevision: 'a'.repeat(64), nextChapterId: chapterId === 'chapter-1' ? 'chapter-2' : undefined,
});

before(async () => {
  storage = await import('../lib/novels/storage');
  ({ setCurrentUser } = await import('../lib/api'));
  setCurrentUser(A);
  await storage.getPendingNovelProgress();
});

beforeEach(async () => {
  setCurrentUser(A);
  const d = await openDB('miaoyomi-novels');
  const names = ['novelChapters', 'novels', 'novelProgress', 'novelOutbox'];
  const tx = d.transaction(names, 'readwrite');
  await Promise.all(names.map((name) => tx.objectStore(name).clear()));
  await tx.done;
  d.close();
});

test('a downloaded novel chapter is visible only to the account that saved it', async () => {
  await storage.saveNovelChapter(payload());
  assert.equal((await storage.getNovelChapter('novel-1', 'chapter-1'))?.chapterTitle, 'A Door in Winter');

  setCurrentUser(B);
  assert.equal(await storage.getNovelChapter('novel-1', 'chapter-1'), undefined);
  assert.deepEqual(await storage.listOfflineNovels(), []);

  setCurrentUser(A);
  assert.equal((await storage.listOfflineNovels())[0]?.downloadedChapters, 1);
});

test('an incomplete payload never becomes an offline download', async () => {
  await assert.rejects(
    storage.saveNovelChapter({ ...payload(), html: '' }),
    /incomplete/i,
  );
  assert.equal(await storage.getNovelChapter('novel-1', 'chapter-1'), undefined);
});

test('an account switch during a download aborts before content is committed', async () => {
  let release!: (value: Response) => void;
  const response = new Promise<Response>((resolve) => { release = resolve; });
  const pending = storage.downloadNovelChapter('novel-1', 'chapter-1', async () => response);
  setCurrentUser(B);
  release(new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } }));

  await assert.rejects(pending, /account changed/i);
  setCurrentUser(A);
  assert.equal(await storage.getNovelChapter('novel-1', 'chapter-1'), undefined);
});

test('a quota failure preserves downloads that were already complete', async () => {
  await storage.saveNovelChapter(payload());
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'novelChapters') throw new DOMException('Device storage is full', 'QuotaExceededError');
    return original.apply(this, args);
  };
  try {
    await assert.rejects(storage.saveNovelChapter(payload('chapter-2')), /storage is full/i);
  } finally {
    IDBObjectStore.prototype.put = original;
  }
  assert.equal((await storage.getNovelChapter('novel-1', 'chapter-1'))?.chapterTitle, 'A Door in Winter');
  assert.equal(await storage.getNovelChapter('novel-1', 'chapter-2'), undefined);
});

test('progress flushes only for the account that queued it', async () => {
  await storage.queueNovelProgress('novel-1', {
    chapterId: 'chapter-1', position: 0.42, completed: false,
    updatedAt: 1_789_000_000_000, mutationId: 'mutation-a',
  });
  const calls: string[] = [];
  const send = async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); };

  setCurrentUser(B);
  assert.equal(await storage.flushNovelProgress(send), 0);
  assert.deepEqual(calls, []);

  setCurrentUser(A);
  assert.equal(await storage.flushNovelProgress(send), 1);
  assert.deepEqual(calls, ['/api/novels/novel-1/progress']);
});

test('offline progress keeps each completed chapter and survives transient failures', async () => {
  await storage.queueNovelProgress('novel-1', {
    chapterId: 'chapter-1', position: 1, completed: true, updatedAt: 100, mutationId: 'm1',
  });
  await storage.queueNovelProgress('novel-1', {
    chapterId: 'chapter-2', position: 0.2, completed: false, updatedAt: 200, mutationId: 'm2',
  });
  assert.equal((await storage.getPendingNovelProgress()).length, 2);

  assert.equal(await storage.flushNovelProgress(async () => { throw new TypeError('offline'); }), 0);
  assert.equal((await storage.getPendingNovelProgress()).length, 2);

  const latest = await storage.getLocalNovelProgress('novel-1');
  assert.equal(latest?.chapterId, 'chapter-2');
  assert.equal(latest?.position, 0.2);
});

test('completion and newer position survive a delivered outbox and delayed local events', async () => {
  await storage.queueNovelProgress('novel-1', { chapterId: 'chapter-1', position: 1, completed: true, updatedAt: 100, mutationId: 'done' });
  await storage.flushNovelProgress(async () => new Response('{}', { status: 200 }));
  await storage.queueNovelProgress('novel-1', { chapterId: 'chapter-1', position: 0.4, completed: false, updatedAt: 200, mutationId: 'reread' });
  await storage.queueNovelProgress('novel-1', { chapterId: 'chapter-1', position: 0.1, completed: false, updatedAt: 150, mutationId: 'delayed' });
  const progress = await storage.getLocalNovelProgress('novel-1');
  assert.equal(progress?.completed, true);
  assert.equal(progress?.position, 0.4);
  assert.equal(progress?.mutationId, 'reread');
});

test('a rejected in-flight outbox event does not delete a newer event', async () => {
  await storage.queueNovelProgress('novel-1', { chapterId: 'chapter-1', position: 0.2, completed: false, updatedAt: 100, mutationId: 'old' });
  await storage.flushNovelProgress(async () => {
    await storage.queueNovelProgress('novel-1', { chapterId: 'chapter-1', position: 0.8, completed: false, updatedAt: 200, mutationId: 'new' });
    return new Response('{}', { status: 403 });
  });
  assert.equal((await storage.getPendingNovelProgress())[0]?.mutationId, 'new');
});

test('details from a captured account cannot be cached after switching accounts', async () => {
  setCurrentUser(B);
  await assert.rejects(storage.cacheNovelDetail({
    id: 'novel-1', sourceId: 'royalroad', path: '/fiction/1', title: 'Private title', language: 'en', inLibrary: true, chapters: [],
  }, A), /account changed/i);
  assert.equal(await storage.getCachedNovelDetail({ id: 'novel-1' }), undefined);
});
