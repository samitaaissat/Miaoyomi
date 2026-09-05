import type { NovelProgress } from './progress';
export interface EngineSource {
  id: string; name: string; lang: string; site: string; version: string;
  enabled: boolean; supported: boolean; supportsLatest: boolean;
  reason?: string; filters?: Record<string, unknown>; isNsfw?: boolean;
}
export interface NovelCard { sourceId: string; path: string; title: string; cover?: string; id?: string }
export interface NovelChapter { id: string; path: string; title: string; number?: number; position: number; saved: boolean }
export interface NovelDetail extends NovelCard {
  id: string; author?: string; summary?: string; language: string;
  chapters: NovelChapter[]; totalPages?: number; inLibrary: boolean;
}
export interface NovelPayload {
  novelId: string; chapterId: string; novelTitle: string; chapterTitle: string;
  html: string; sourceUrl: string; archiveRevision: string;
  previousChapterId?: string; nextChapterId?: string;
}
export interface NovelEngine {
  sources(): Promise<EngineSource[]>;
  source(id: string): Promise<EngineSource>;
  enable(id: string, enabled: boolean): Promise<EngineSource>;
  invoke(sourceId: string, method: string, args: unknown[]): Promise<any>;
  asset(sourceId: string, url: string): Promise<{bytes: Buffer; contentType: string}>;
}
export type LibraryNovel = NovelDetail & {progress?: NovelProgress};

export class NovelError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); }
}
