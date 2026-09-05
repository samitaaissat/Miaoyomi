import { api } from './api';

export interface SourceChapterChoice {
  id: string;
  number: number;
  title?: string;
  lang?: string | null;
  pages?: number | null;
  publishedAt?: string | null;
}

export interface OpenSourceChapterRequest {
  source: string;
  sourceId: string;
  chapterId: string;
}

export interface OpenSourceChapterResult {
  bookId: string;
  readerUrl: string;
  reused: boolean;
}

type ApiCall = (path: string, opts: { json: unknown }) => Promise<OpenSourceChapterResult>;

/** Source chapter ids, rather than display numbers, preserve translations and duplicate-number releases. */
export const sourceChapterKey = (chapter: Pick<SourceChapterChoice, 'id' | 'number'>): string =>
  `${encodeURIComponent(chapter.id)}:${chapter.number}`;

export const openSourceChapter = (
  request: OpenSourceChapterRequest,
  call: ApiCall = api,
): Promise<OpenSourceChapterResult> => call('/api/sources/chapter/open', { json: request });
