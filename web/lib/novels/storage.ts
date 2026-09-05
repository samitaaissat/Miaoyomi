import { openDB, type IDBPDatabase } from 'idb';
import { api, ApiError, getCurrentUser } from '../api';
import type { NovelDetail, NovelPayload, NovelProgress } from './types';

const DB_NAME = 'miaoyomi-novels';
const DB_VERSION = 1;
const OPEN_TIMEOUT = 4000;

interface StoredChapter extends NovelPayload { key: string; userId: string; savedAt: number; bytes: number }
interface StoredNovel extends NovelDetail { key: string; sourceKey: string; userId: string; cachedAt: number }
interface StoredProgress extends NovelProgress { key: string; userId: string; novelId: string }
interface OutboxRecord extends StoredProgress { tries: number }
export interface OfflineNovelSummary { novelId: string; title: string; downloadedChapters: number; savedAt: number }
type ProgressSender = (url: string, init: { method: 'PUT'; json: NovelProgress }) => Promise<Response | unknown>;

let database: Promise<IDBPDatabase> | null = null;
function db(): Promise<IDBPDatabase> {
  if (database) return database;
  const opened = openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      const chapters = d.createObjectStore('novelChapters', { keyPath: 'key' });
      chapters.createIndex('byUser', 'userId');
      const novels = d.createObjectStore('novels', { keyPath: 'key' });
      novels.createIndex('byUser', 'userId');
      novels.createIndex('bySource', 'sourceKey');
      const progress = d.createObjectStore('novelProgress', { keyPath: 'key' });
      progress.createIndex('byUser', 'userId');
      const outbox = d.createObjectStore('novelOutbox', { keyPath: 'key' });
      outbox.createIndex('byUser', 'userId');
    },
    blocked() { database = null; },
    blocking(_current, _blocked, event) { (event.target as IDBDatabase | null)?.close(); database = null; },
    terminated() { database = null; },
  });
  database = Promise.race([
    opened,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Novel offline storage did not open in time.')), OPEN_TIMEOUT)),
  ]).catch((error) => { database = null; throw error; });
  return database;
}

function owner(): string {
  const id = getCurrentUser();
  if (!id) throw new Error('Sign in to use novel offline storage.');
  return id;
}
const chapterKey = (userId: string, novelId: string, chapterId: string) => `${userId}:${novelId}:${chapterId}`;
const novelKey = (userId: string, novelId: string) => `${userId}:${novelId}`;
const sourceKey = (userId: string, sourceId: string, path: string) => `${userId}:${sourceId}:${path}`;
const progressKey = (userId: string, novelId: string, chapterId: string) => `${userId}:${novelId}:${chapterId}`;

function completePayload(value: NovelPayload): boolean {
  return !!value && [value.novelId, value.chapterId, value.novelTitle, value.chapterTitle, value.html, value.sourceUrl]
    .every((field) => typeof field === 'string' && field.trim().length > 0)
    && typeof value.archiveRevision === 'string' && /^[a-f0-9]{64}$/.test(value.archiveRevision);
}
function storageError(error: unknown): Error {
  if ((error as { name?: string })?.name === 'QuotaExceededError') {
    return new Error('Device storage is full. Earlier downloads are still available.');
  }
  return error instanceof Error ? error : new Error('The chapter could not be saved on this device.');
}

async function primeNovelShell(payload: NovelPayload): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1500)),
    ]);
    if (!reg?.active) throw new Error('Offline reader setup is not ready. Reload this page online, then try Download again.');
    const reader = typeof location !== 'undefined' && location.pathname.startsWith('/novels/read')
      ? location.href
      : `/novels/read?novelId=${encodeURIComponent(payload.novelId)}&chapterId=${encodeURIComponent(payload.chapterId)}`;
    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('The offline reader could not be saved. Keep this page online and retry Download.'));
      }, 10_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data?.ok) resolve();
        else reject(new Error('The offline reader could not be saved. Keep this page online and retry Download.'));
      };
      reg.active!.postMessage({
        type: 'miaoyomi-prime-novel',
        urls: [reader, `/novels/title?id=${encodeURIComponent(payload.novelId)}`],
      }, [channel.port2]);
    });
  } catch (error) { throw storageError(error); }
}

async function saveForOwner(userId: string, payload: NovelPayload): Promise<void> {
  if (!completePayload(payload)) throw new Error('The chapter download is incomplete and was not saved.');
  await primeNovelShell(payload);
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before the download completed.');
  const d = await db();
  const tx = d.transaction('novelChapters', 'readwrite');
  const record: StoredChapter = {
    ...payload, key: chapterKey(userId, payload.novelId, payload.chapterId), userId,
    savedAt: Date.now(), bytes: new Blob([payload.html]).size,
  };
  try {
    await tx.store.put(record);
    if (getCurrentUser() !== userId) {
      tx.abort();
      throw new Error('The signed-in account changed before the download completed.');
    }
    await tx.done;
  } catch (error) { throw storageError(error); }
}

export async function saveNovelChapter(payload: NovelPayload): Promise<void> { return saveForOwner(owner(), payload); }

export async function downloadNovelChapter(
  novelId: string,
  chapterId: string,
  fetcher?: (url: string, init: RequestInit) => Promise<Response>,
): Promise<NovelPayload> {
  const userId = owner();
  const url = `/api/novels/${encodeURIComponent(novelId)}/chapters/${encodeURIComponent(chapterId)}/open`;
  let payload: NovelPayload;
  if (fetcher) {
    const response = await fetcher(url, { method: 'POST', credentials: 'include' });
    if (!response.ok) throw new Error(`Chapter download failed (HTTP ${response.status}).`);
    payload = await response.json() as NovelPayload;
  } else payload = await api<NovelPayload>(url, { method: 'POST' });
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before the download completed.');
  await saveForOwner(userId, payload);
  return payload;
}

export async function getNovelChapter(novelId: string, chapterId: string): Promise<NovelPayload | undefined> {
  const userId = getCurrentUser();
  if (!userId) return undefined;
  try { return await (await db()).get('novelChapters', chapterKey(userId, novelId, chapterId)) as StoredChapter | undefined; }
  catch { return undefined; }
}
export async function deleteNovelChapter(novelId: string, chapterId: string): Promise<void> {
  const userId = owner();
  const d = await db();
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before the download was removed.');
  await d.delete('novelChapters', chapterKey(userId, novelId, chapterId));
}
export async function listOfflineNovels(): Promise<OfflineNovelSummary[]> {
  const userId = getCurrentUser();
  if (!userId) return [];
  try {
    const chapters = await (await db()).getAllFromIndex('novelChapters', 'byUser', userId) as StoredChapter[];
    const grouped = new Map<string, OfflineNovelSummary>();
    for (const chapter of chapters) {
      const current = grouped.get(chapter.novelId);
      if (current) { current.downloadedChapters++; current.savedAt = Math.max(current.savedAt, chapter.savedAt); }
      else grouped.set(chapter.novelId, { novelId: chapter.novelId, title: chapter.novelTitle, downloadedChapters: 1, savedAt: chapter.savedAt });
    }
    return [...grouped.values()].sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; }
}

export async function cacheNovelDetail(detail: NovelDetail, userId = owner()): Promise<void> {
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before novel details were cached.');
  const record: StoredNovel = {
    ...detail, key: novelKey(userId, detail.id), sourceKey: sourceKey(userId, detail.sourceId, detail.path), userId, cachedAt: Date.now(),
  };
  const d = await db();
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before novel details were cached.');
  const tx = d.transaction('novels', 'readwrite');
  await tx.store.put(record);
  if (getCurrentUser() !== userId) {
    tx.abort();
    throw new Error('The signed-in account changed before novel details were cached.');
  }
  await tx.done;
}
export async function getCachedNovelDetail(ref: { id?: string; sourceId?: string; path?: string }): Promise<NovelDetail | undefined> {
  const userId = getCurrentUser();
  if (!userId) return undefined;
  try {
    const d = await db();
    if (ref.id) return await d.get('novels', novelKey(userId, ref.id)) as StoredNovel | undefined;
    if (ref.sourceId && ref.path) return await d.getFromIndex('novels', 'bySource', sourceKey(userId, ref.sourceId, ref.path)) as StoredNovel | undefined;
  } catch { /* unavailable device cache is a cache miss */ }
  return undefined;
}

export async function queueNovelProgress(novelId: string, progress: NovelProgress, userId = owner()): Promise<void> {
  const d = await db();
  if (getCurrentUser() !== userId) throw new Error('The signed-in account changed before progress was queued.');
  const key = progressKey(userId, novelId, progress.chapterId);
  const tx = d.transaction(['novelProgress', 'novelOutbox'], 'readwrite');
  const [previous, pending] = await Promise.all([
    tx.objectStore('novelProgress').get(key) as Promise<StoredProgress | undefined>,
    tx.objectStore('novelOutbox').get(key) as Promise<OutboxRecord | undefined>,
  ]);
  const latest = previous && previous.updatedAt > progress.updatedAt ? previous : progress;
  const record: OutboxRecord = {
    ...latest, completed: !!previous?.completed || progress.completed, key, userId, novelId, tries: pending?.tries ?? 0,
  };
  await Promise.all([
    tx.objectStore('novelProgress').put(record as StoredProgress),
    tx.objectStore('novelOutbox').put(record),
  ]);
  if (getCurrentUser() !== userId) {
    tx.abort();
    throw new Error('The signed-in account changed before progress was queued.');
  }
  await tx.done;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker?.ready,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1200)),
    ]);
    await (reg as any)?.sync?.register('miaoyomi-novel-progress');
  } catch { /* foreground reconnect and visibility flushes are the reliable path */ }
}
export async function getPendingNovelProgress(): Promise<OutboxRecord[]> {
  const userId = getCurrentUser();
  if (!userId) return [];
  try { return await (await db()).getAllFromIndex('novelOutbox', 'byUser', userId) as OutboxRecord[]; }
  catch { return []; }
}
export async function getLocalNovelProgress(novelId: string): Promise<NovelProgress | null> {
  const userId = getCurrentUser();
  if (!userId) return null;
  try {
    const all = await (await db()).getAllFromIndex('novelProgress', 'byUser', userId) as StoredProgress[];
    return all.filter((item) => item.novelId === novelId).sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
  } catch { return null; }
}
function permanentStatus(status: number): boolean { return status >= 400 && status < 500 && status !== 401 && status !== 429; }

async function removeDelivered(d: IDBPDatabase, record: OutboxRecord): Promise<void> {
  const tx = d.transaction('novelOutbox', 'readwrite');
  const current = await tx.store.get(record.key) as OutboxRecord | undefined;
  if (current?.mutationId === record.mutationId) await tx.store.delete(record.key);
  await tx.done;
}

export async function flushNovelProgress(sender?: ProgressSender): Promise<number> {
  const userId = getCurrentUser();
  if (!userId) return 0;
  const d = await db();
  const records = await d.getAllFromIndex('novelOutbox', 'byUser', userId) as OutboxRecord[];
  const send: ProgressSender = sender || ((url, init) => api(url, { ...init, accountId: userId }));
  let delivered = 0;
  for (const record of records.sort((a, b) => a.updatedAt - b.updatedAt)) {
    if (getCurrentUser() !== userId) break;
    try {
      const result = await send(`/api/novels/${encodeURIComponent(record.novelId)}/progress`, {
        method: 'PUT',
        json: { chapterId: record.chapterId, position: record.position, completed: record.completed, updatedAt: record.updatedAt, mutationId: record.mutationId },
      });
      if (result instanceof Response && !result.ok) {
        if (permanentStatus(result.status)) await removeDelivered(d, record);
        continue;
      }
      if (getCurrentUser() !== userId) break;
      await removeDelivered(d, record);
      delivered++;
    } catch (error) {
      if (error instanceof ApiError && permanentStatus(error.status)) await removeDelivered(d, record);
      else {
        const current = await d.get('novelOutbox', record.key) as OutboxRecord | undefined;
        if (current?.mutationId === record.mutationId) await d.put('novelOutbox', { ...current, tries: current.tries + 1 });
      }
    }
  }
  return delivered;
}
