export type ArchiveNovel = {
  id: string; title: string; language: string; author?: string;
  sourceUrl: string; sourceId: string; sourcePath: string;
};
export type ArchiveChapter = {
  id: string; title: string; position: number; sourcePath: string; sourceUrl: string; html: string;
};
export type AssetFetcher = (url: string) => Promise<{ bytes: Buffer; contentType: string }>;
export type ArchivedChapter = Omit<ArchiveChapter, 'html'>;
