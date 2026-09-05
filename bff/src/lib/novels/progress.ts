export interface NovelProgress {
  chapterId: string;
  position: number;
  completed: boolean;
  updatedAt: number;
  mutationId: string;
}

/** Merge one chapter's progress. Completion and the current reading location are independent. */
export function mergeNovelProgress(
  previous: NovelProgress | null, incoming: NovelProgress, now = Date.now(),
): NovelProgress {
  if (!Number.isFinite(incoming.position) || incoming.position < 0 || incoming.position > 1) {
    throw new Error('Invalid reading position');
  }
  if (!Number.isFinite(incoming.updatedAt) || incoming.updatedAt < 0) throw new Error('Invalid timestamp');
  if (previous && previous.chapterId !== incoming.chapterId) throw new Error('Cannot merge different chapter progress');
  const candidate = { ...incoming, updatedAt: Math.min(incoming.updatedAt, now) };
  const latest = previous && previous.updatedAt >= candidate.updatedAt ? previous : candidate;
  return { ...latest, completed: !!(previous?.completed || candidate.completed) };
}
