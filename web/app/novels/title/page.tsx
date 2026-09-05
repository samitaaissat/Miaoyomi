'use client';
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { apiBlob, getCurrentUser } from '@/lib/api';
import { novelsApi, novelErrorMessage } from '@/lib/novels/client';
import { cacheNovelDetail, getCachedNovelDetail, getLocalNovelProgress } from '@/lib/novels/storage';
import type { NovelDetail, NovelProgress } from '@/lib/novels/types';
import { latestNovelProgress } from '@/lib/novels/progress';
import { Img } from '@/components/ui';
import { IcBookmark, IcChevronLeft, IcDownload, IcPlay, IcRefresh } from '@/components/icons';

function TitleContent() {
  const { user } = useAuth();
  const ownerId = user?.id;
  const params = useSearchParams();
  const id = params.get('id') || undefined;
  const sourceId = params.get('sourceId') || undefined;
  const path = params.get('path') || undefined;
  const ref = useMemo(() => ({ id, sourceId, path }), [id, sourceId, path]);
  const qc = useQueryClient();
  const [offlineFallback, setOfflineFallback] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const detailKey = ['novel-detail', ownerId, id || sourceId, path];
  const assertOwner = () => {
    if (!ownerId || getCurrentUser() !== ownerId) throw new Error('The signed-in account changed.');
  };
  const detailQuery = useQuery({
    queryKey: detailKey,
    enabled: !!ownerId && (!!id || !!(sourceId && path)),
    retry: false,
    queryFn: async () => {
      try {
        const detail = await novelsApi.detail(ref);
        assertOwner();
        setOfflineFallback(false);
        await cacheNovelDetail(detail, ownerId).catch(() => {});
        return detail;
      } catch (error) {
        assertOwner();
        const cached = await getCachedNovelDetail(ref);
        if (cached) { setOfflineFallback(true); return cached; }
        throw error;
      }
    },
  });
  const detail = detailQuery.data;
  const progressQuery = useQuery({
    queryKey: ['novel-progress', ownerId, detail?.id],
    enabled: !!detail?.id,
    retry: false,
    queryFn: async () => {
      const local = await getLocalNovelProgress(detail!.id);
      try { return latestNovelProgress(local, (await novelsApi.progress(detail!.id)).progress); }
      catch { return local; }
    },
  });
  const library = useMutation({
    mutationFn: (saved: boolean) => novelsApi.setLibrary(detail!.id, saved),
    onSuccess: async (_result, saved) => {
      if (detail) await cacheNovelDetail({ ...detail, inLibrary: saved }, ownerId).catch(() => {});
      qc.setQueryData(detailKey, (old: NovelDetail | undefined) => old ? { ...old, inLibrary: saved } : old);
      qc.invalidateQueries({ queryKey: ['novel-library'] });
    },
  });
  const [chapterPage, setChapterPage] = useState(1);
  const refresh = useMutation({
    mutationFn: () => novelsApi.refreshChapters(detail!.id, String(chapterPage + 1)),
    onSuccess: async (next) => {
      setChapterPage((page) => page + 1);
      qc.setQueryData(detailKey, next);
      await cacheNovelDetail(next, ownerId).catch(() => {});
    },
  });
  useEffect(() => { if (detail) setChapterPage(1); }, [detail?.id]);

  const exportEpub = async () => {
    if (!detail || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const blob = await apiBlob(`/api/novels/${encodeURIComponent(detail.id)}/export.epub`);
      assertOwner();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${detail.title.replace(/[\\/:*?"<>|]/g, '_')}.epub`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { setExportError(novelErrorMessage(error)); }
    finally { setExporting(false); }
  };

  if (!id && !(sourceId && path)) return <Message title="Missing title" text="Open this page from a novel source or your saved library." />;
  if (detailQuery.isLoading) return <div className="min-h-screen-d px-4 py-8 lg:px-0"><div className="skeleton h-[60vh] rounded-3xl" /></div>;
  if (detailQuery.error || !detail) return <Message title="This novel could not be opened" text={novelErrorMessage(detailQuery.error)} retry={() => detailQuery.refetch()} />;

  const progress = progressQuery.data as NovelProgress | null | undefined;
  const activeIndex = progress ? detail.chapters.findIndex((chapter) => chapter.id === progress.chapterId) : -1;
  const startIndex = activeIndex >= 0 && progress?.completed ? Math.min(activeIndex + 1, detail.chapters.length - 1) : Math.max(0, activeIndex);
  const start = detail.chapters[startIndex];
  const anySaved = detail.chapters.some((chapter) => chapter.saved);
  return (
    <div className="min-h-screen-d pb-12">
      <header className="safe-top px-4 py-4 lg:px-0 lg:pt-7"><Link href="/novels" className="inline-flex items-center gap-1 text-sm text-fog-400 hover:text-accent"><IcChevronLeft width={18} />Novels</Link></header>
      <section className="relative overflow-hidden border-y border-ink-700 bg-ink-900 lg:rounded-4xl lg:border">
        {detail.cover && <><Img src={detail.cover} alt="" className="absolute inset-0 h-full w-full opacity-25 blur-3xl" /><div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/75 to-ink-950/45" /></>}
        <div className="relative grid gap-6 px-4 py-8 sm:grid-cols-[12rem_1fr] lg:px-8 lg:py-10">
          <div className="mx-auto aspect-[2/3] w-40 overflow-hidden rounded-2xl border border-ink-600 shadow-lift sm:mx-0 sm:w-full">
            {detail.cover ? <Img src={detail.cover} alt={`Cover of ${detail.title}`} className="h-full w-full" eager /> : <div className="grid h-full place-items-center bg-ink-800 font-display text-6xl text-fog-600">{detail.title[0]}</div>}
          </div>
          <div className="self-end">
            <p className="text-xs font-semibold uppercase tracking-[.2em] text-accent">{detail.language} · {detail.sourceId}</p>
            <h1 className="mt-2 max-w-4xl font-display text-3xl font-bold leading-tight sm:text-4xl lg:text-5xl">{detail.title}</h1>
            {detail.author && <p className="mt-2 text-fog-300">by {detail.author}</p>}
            {detail.summary && <p className="mt-4 max-w-3xl whitespace-pre-line text-sm leading-relaxed text-fog-300">{detail.summary}</p>}
            <div className="mt-6 flex flex-wrap gap-2">
              {start ? <Link href={`/novels/read?novelId=${encodeURIComponent(detail.id)}&chapterId=${encodeURIComponent(start.id)}`} className="btn-accent"><IcPlay width={17} />{progress ? 'Continue reading' : 'Start reading'}</Link> : <span className="text-sm text-fog-400">No readable chapters yet.</span>}
              <button type="button" className={`btn-ghost ${detail.inLibrary ? 'border-accent/50 text-accent' : ''}`} disabled={library.isPending} onClick={() => library.mutate(!detail.inLibrary)}><IcBookmark width={17} />{detail.inLibrary ? 'Saved to library' : 'Save to library'}</button>
              {anySaved && <button className="btn-ghost" disabled={exporting} onClick={exportEpub}><IcDownload width={17} />{exporting ? 'Exporting…' : 'Export saved EPUB'}</button>}
            </div>
            {offlineFallback && <p className="mt-4 text-xs text-amber-300">Showing the last details saved on this device.</p>}
            {(library.error || refresh.error) && <p className="mt-3 text-sm text-red-300">{novelErrorMessage(library.error || refresh.error)}</p>}
            {exportError && <p className="mt-3 text-sm text-red-300">{exportError}</p>}
          </div>
        </div>
      </section>
      <section className="px-4 py-8 lg:px-0">
        <div className="mb-4 flex items-end justify-between gap-4"><div><p className="text-xs uppercase tracking-[.18em] text-fog-500">{detail.chapters.length} loaded</p><h2 className="font-display text-2xl font-bold">Chapters</h2></div></div>
        <div className="overflow-hidden rounded-3xl border border-ink-700 bg-ink-850/70">
          {detail.chapters.map((chapter, index) => {
            const current = progress?.chapterId === chapter.id;
            return <Link key={chapter.id} href={`/novels/read?novelId=${encodeURIComponent(detail.id)}&chapterId=${encodeURIComponent(chapter.id)}`}
              className="flex items-center gap-3 border-b border-ink-700/70 px-4 py-3.5 transition last:border-0 hover:bg-ink-800">
              <span className="w-9 shrink-0 font-display text-xs text-fog-600">{chapter.number ?? index + 1}</span>
              <span className={`min-w-0 flex-1 truncate text-sm ${current ? 'font-semibold text-accent' : 'text-fog-200'}`}>{chapter.title}</span>
              {chapter.saved && <span className="rounded-full bg-accent-soft px-2 py-1 text-[10px] font-semibold text-accent">EPUB</span>}
              {current && <span className="text-xs text-fog-500">{progress?.completed ? 'Read' : `${Math.round((progress?.position || 0) * 100)}%`}</span>}
            </Link>;
          })}
        </div>
        {detail.totalPages && chapterPage < detail.totalPages && <button type="button" className="btn-ghost mx-auto mt-6 flex" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? 'Loading…' : 'Load more chapters'}</button>}
      </section>
    </div>
  );
}

function Message({ title, text, retry }: { title: string; text: string; retry?: () => void }) {
  return <div className="min-h-screen-d px-4 py-20 text-center"><p className="font-display text-2xl font-bold">{title}</p><p className="mx-auto mt-2 max-w-md text-sm text-fog-400">{text}</p>{retry && <button onClick={retry} className="btn-ghost mt-5"><IcRefresh width={17} />Retry</button>}</div>;
}

export default function NovelTitlePage() {
  return <Suspense fallback={<div className="min-h-screen-d p-8 text-fog-400">Opening title…</div>}><TitleContent /></Suspense>;
}
