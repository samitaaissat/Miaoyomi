import type { NovelProgress } from './types';

/** The outbox may be ahead of the server when a title is reopened before reconnect sync finishes. */
export function latestNovelProgress(local: NovelProgress | null, remote: NovelProgress | null): NovelProgress | null {
  if (!local) return remote;
  if (!remote) return local;
  const latest = remote.updatedAt >= local.updatedAt ? remote : local;
  return local.chapterId === remote.chapterId
    ? { ...latest, completed: local.completed || remote.completed }
    : latest;
}
