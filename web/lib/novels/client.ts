import { api } from '../api';
import type { EngineSource, NovelDetail, NovelPage, NovelPayload, NovelProgress } from './types';

export function novelBrowseUrl(sourceId: string, mode: string, page: number, filters?: unknown): string {
  const query = new URLSearchParams({ sourceId, mode, page: String(page) });
  if (filters && Object.keys(filters as object).length) query.set('filters', JSON.stringify(filters));
  return `/api/novels/browse?${query}`;
}
export function novelSearchUrl(sourceId: string, queryText: string, page: number): string {
  return `/api/novels/search?${new URLSearchParams({ sourceId, q: queryText, page: String(page) })}`;
}
export function novelDetailUrl(ref: { id?: string; sourceId?: string; path?: string }): string {
  if (ref.id) return `/api/novels/${encodeURIComponent(ref.id)}`;
  if (!ref.sourceId || !ref.path) throw new Error('A saved novel id or source and path is required.');
  return `/api/novels/detail?${new URLSearchParams({ sourceId: ref.sourceId, path: ref.path })}`;
}
export const novelsApi = {
  sources: () => api<{ sources: EngineSource[] }>('/api/novels/sources'),
  setSource: (id: string, enabled: boolean) => api<{ source: EngineSource }>(`/api/novels/sources/${encodeURIComponent(id)}`, { json: { enabled } }),
  browse: (sourceId: string, mode: 'popular' | 'latest', page: number, filters?: unknown) => api<NovelPage>(novelBrowseUrl(sourceId, mode, page, filters)),
  search: (sourceId: string, query: string, page: number) => api<NovelPage>(novelSearchUrl(sourceId, query, page)),
  detail: (ref: { id?: string; sourceId?: string; path?: string }) => api<NovelDetail>(novelDetailUrl(ref)),
  library: () => api<{ items: Array<NovelDetail & { progress?: NovelProgress }> }>('/api/novels/library'),
  setLibrary: (id: string, saved: boolean) => api<{ ok: true }>(`/api/novels/${encodeURIComponent(id)}/library`, { method: 'PUT', json: { saved } }),
  refreshChapters: (id: string, page: string) => api<NovelDetail>(`/api/novels/${encodeURIComponent(id)}/chapters/refresh`, { json: { page } }),
  openChapter: (novelId: string, chapterId: string) => api<NovelPayload>(`/api/novels/${encodeURIComponent(novelId)}/chapters/${encodeURIComponent(chapterId)}/open`, { method: 'POST' }),
  savedChapter: (novelId: string, chapterId: string) => api<NovelPayload>(`/api/novels/${encodeURIComponent(novelId)}/chapters/${encodeURIComponent(chapterId)}`),
  progress: (novelId: string) => api<{ progress: NovelProgress | null }>(`/api/novels/${encodeURIComponent(novelId)}/progress`),
};

export function novelErrorMessage(error: unknown): string {
  const body = (error as { body?: string })?.body;
  if (body) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.message === 'string') return parsed.message;
      if (typeof parsed.error === 'string') return parsed.error;
    } catch { /* plain body handled below */ }
    if (body.length < 180) return body;
  }
  return error instanceof Error && error.message && !error.message.startsWith('API ')
    ? error.message
    : 'This novel source could not answer. Try again in a moment.';
}
