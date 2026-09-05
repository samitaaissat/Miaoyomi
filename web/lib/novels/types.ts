export interface EngineSource {
  id: string;
  name: string;
  lang: string;
  site: string;
  version: string;
  enabled: boolean;
  supported: boolean;
  reason?: string;
  filters?: Record<string, unknown>;
  supportsLatest: boolean;
  error?: string;
}

export interface NovelCard { sourceId: string; path: string; title: string; cover?: string; id?: string }
export interface NovelChapter { id: string; path: string; title: string; number?: number; position: number; saved: boolean }
export interface NovelDetail {
  id: string; sourceId: string; path: string; title: string; cover?: string; author?: string; summary?: string;
  language: string; chapters: NovelChapter[]; totalPages?: number; inLibrary: boolean;
}
export interface NovelPayload {
  novelId: string; chapterId: string; novelTitle: string; chapterTitle: string; html: string; sourceUrl: string;
  archiveRevision: string; previousChapterId?: string; nextChapterId?: string;
}
export interface NovelProgress { chapterId: string; position: number; completed: boolean; updatedAt: number; mutationId: string }
export interface NovelPage { items: NovelCard[]; page: number; hasMore: boolean }
