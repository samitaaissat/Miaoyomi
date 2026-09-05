'use client';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { getCurrentUser } from '@/lib/api';
import { novelsApi, novelErrorMessage } from '@/lib/novels/client';
import { sanitizeNovelHtml } from '@/lib/novels/content';
import {
  deleteNovelChapter, flushNovelProgress, getLocalNovelProgress, getNovelChapter,
  queueNovelProgress, saveNovelChapter,
} from '@/lib/novels/storage';
import type { NovelPayload, NovelProgress } from '@/lib/novels/types';
import { latestNovelProgress } from '@/lib/novels/progress';
import { IcChevronLeft, IcChevronRight, IcDownload, IcSettings, IcTrash, IcWifiOff, IcX } from '@/components/icons';

type ReaderTheme = 'dark' | 'paper' | 'sepia';
interface ReaderPrefs { size: number; lineHeight: number; width: number; theme: ReaderTheme }
const DEFAULT_PREFS: ReaderPrefs = { size: 18, lineHeight: 1.78, width: 720, theme: 'dark' };
const themeStyle: Record<ReaderTheme, { background: string; color: string; muted: string }> = {
  dark: { background: '#09090d', color: '#ececf2', muted: '#9292a3' },
  paper: { background: '#f6f2e9', color: '#24211d', muted: '#6d665c' },
  sepia: { background: '#ead9b8', color: '#3d2f23', muted: '#75624e' },
};
function loadPrefs(): ReaderPrefs {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem('miaoyomi-novel-reader') || '{}') }; }
  catch { return DEFAULT_PREFS; }
}

function ReaderContent() {
  const params = useSearchParams();
  const novelId = params.get('novelId') || '';
  const chapterId = params.get('chapterId') || '';
  const { user } = useAuth();
  const qc = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const [payload, setPayload] = useState<NovelPayload | null>(null);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState(false);
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_PREFS);
  const [resume, setResume] = useState<NovelProgress | null>(null);
  const initialized = useRef(false);
  const progressTimer = useRef<number | null>(null);
  const currentPosition = useRef(0);
  const dirtyPosition = useRef(false);

  useEffect(() => { setPrefs(loadPrefs()); }, []);
  const updatePrefs = (next: Partial<ReaderPrefs>) => {
    setPrefs((current) => {
      const value = { ...current, ...next };
      localStorage.setItem('miaoyomi-novel-reader', JSON.stringify(value));
      return value;
    });
  };

  useEffect(() => {
    let alive = true;
    initialized.current = false;
    setPayload(null);
    setError('');
    if (!novelId || !chapterId) { setError('This reader link is missing its novel or chapter.'); return; }
    (async () => {
      const localProgress = await getLocalNovelProgress(novelId);
      let progress = localProgress;
      try {
        const remote = await novelsApi.progress(novelId);
        progress = latestNovelProgress(progress, remote.progress);
      } catch { /* local progress remains available offline */ }
      if (alive && progress?.chapterId === chapterId) setResume(progress);
      const cached = await getNovelChapter(novelId, chapterId);
      if (cached) {
        if (alive) { setPayload(cached); setOffline(!navigator.onLine); setDownloaded(true); }
        return;
      }
      try {
        const opened = await novelsApi.openChapter(novelId, chapterId);
        if (alive) {
          setPayload(opened); setOffline(false); setDownloaded(false);
          void qc.invalidateQueries({ queryKey: ['novel-detail'] });
        }
      } catch (readError) {
        if (alive) setError(novelErrorMessage(readError));
      }
    })();
    return () => { alive = false; if (progressTimer.current) window.clearTimeout(progressTimer.current); };
  }, [novelId, chapterId, user?.id]);

  const cleanHtml = useMemo(() => payload ? sanitizeNovelHtml(payload.html) : '', [payload?.html]);
  useEffect(() => {
    const element = scroller.current;
    if (!payload || !element || initialized.current) return;
    const position = resume?.chapterId === chapterId ? resume.position : 0;
    currentPosition.current = position;
    const restore = () => { element.scrollTop = Math.max(0, position * Math.max(0, element.scrollHeight - element.clientHeight)); };
    requestAnimationFrame(() => { restore(); window.setTimeout(restore, 120); initialized.current = true; });
  }, [payload, resume, chapterId, cleanHtml]);

  const persist = useCallback((position: number, completed = false) => {
    if (!novelId || !chapterId || !user?.id || getCurrentUser() !== user.id || !initialized.current) return;
    currentPosition.current = position;
    dirtyPosition.current = false;
    const progress: NovelProgress = {
      chapterId,
      position: Math.max(0, Math.min(1, position)),
      completed,
      updatedAt: Date.now(),
      mutationId: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
    };
    void queueNovelProgress(novelId, progress, user.id).then(async () => {
      await flushNovelProgress();
      void qc.invalidateQueries({ queryKey: ['novel-progress'] });
      void qc.invalidateQueries({ queryKey: ['novel-library'] });
    }).catch(() => {});
  }, [novelId, chapterId, user?.id, qc]);

  const onScroll = () => {
    const element = scroller.current;
    if (!element || !initialized.current) return;
    const position = element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
    currentPosition.current = position;
    dirtyPosition.current = true;
    if (progressTimer.current) window.clearTimeout(progressTimer.current);
    progressTimer.current = window.setTimeout(() => persist(position, position >= 0.985), 650);
  };
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') persist(currentPosition.current, currentPosition.current >= 0.985);
      else void flushNovelProgress();
    };
    const onOnline = () => { setOffline(false); void flushNovelProgress(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
      if (dirtyPosition.current) persist(currentPosition.current, currentPosition.current >= 0.985);
    };
  }, [persist]);

  const toggleDownload = async () => {
    if (!payload || saving) return;
    setSaving(true);
    setError('');
    try {
      if (downloaded) await deleteNovelChapter(payload.novelId, payload.chapterId);
      else await saveNovelChapter(payload);
      setDownloaded((value) => !value);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'This chapter could not be saved.'); }
    finally { setSaving(false); }
  };

  const colors = themeStyle[prefs.theme];
  if (error && !payload) return <div className="grid h-screen-d place-items-center bg-ink-950 px-6 text-center"><div><p className="font-display text-2xl font-bold">Chapter unavailable</p><p className="mt-2 max-w-md text-sm text-fog-400">{error}</p><Link href={`/novels/title?id=${encodeURIComponent(novelId)}`} className="btn-ghost mt-5">Back to title</Link></div></div>;
  if (!payload) return <div className="grid h-screen-d place-items-center bg-ink-950 text-sm text-fog-400">Opening chapter…</div>;

  return (
    <div className="h-screen-d overflow-hidden" style={{ background: colors.background, color: colors.color }}>
      <header className="safe-top absolute inset-x-0 top-0 z-20 border-b border-black/10 bg-[color:inherit]/90 px-3 pb-2 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-2">
          <Link href={`/novels/title?id=${encodeURIComponent(novelId)}`} className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-black/10" aria-label="Back to title"><IcChevronLeft width={21} /></Link>
          <div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold uppercase tracking-[.16em] opacity-55">{payload.novelTitle}</p><h1 className="truncate text-sm font-semibold">{payload.chapterTitle}</h1></div>
          {offline && <span title="Reading from this device"><IcWifiOff width={18} /></span>}
          <button onClick={toggleDownload} disabled={saving} className={`grid h-10 w-10 place-items-center rounded-full hover:bg-black/10 ${downloaded ? 'text-accent' : ''}`} aria-label={downloaded ? 'Remove download' : 'Download chapter'}>{downloaded ? <IcTrash width={19} /> : <IcDownload width={19} />}</button>
          <button onClick={() => setSettings(true)} className="grid h-10 w-10 place-items-center rounded-full hover:bg-black/10" aria-label="Reader settings"><IcSettings width={19} /></button>
        </div>
      </header>
      <div ref={scroller} onScroll={onScroll} data-lenis-prevent className="h-full overflow-y-auto px-5 pb-32 pt-28" style={{ scrollBehavior: initialized.current ? 'smooth' : 'auto' }}>
        <article className="mx-auto" style={{ maxWidth: prefs.width, fontSize: prefs.size, lineHeight: prefs.lineHeight }}>
          <h2 className="mb-10 font-display text-[1.65em] font-bold leading-tight">{payload.chapterTitle}</h2>
          <div className="novel-prose" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
          <footer className="mt-16 border-t border-current/15 pt-8">
            <p className="text-center text-sm opacity-55">End of chapter</p>
            <div className="mt-5 flex items-center justify-between gap-3">
              {payload.previousChapterId ? <Link onClick={() => persist(currentPosition.current)} href={`/novels/read?novelId=${encodeURIComponent(novelId)}&chapterId=${encodeURIComponent(payload.previousChapterId)}`} className="btn-ghost px-4"><IcChevronLeft width={17} />Previous</Link> : <span />}
              {payload.nextChapterId ? <Link onClick={() => persist(1, true)} href={`/novels/read?novelId=${encodeURIComponent(novelId)}&chapterId=${encodeURIComponent(payload.nextChapterId)}`} className="btn-accent px-4">Next<IcChevronRight width={17} /></Link> : <Link href={`/novels/title?id=${encodeURIComponent(novelId)}`} className="btn-ghost">Title details</Link>}
            </div>
            <a href={payload.sourceUrl} target="_blank" rel="noreferrer noopener" className="mx-auto mt-8 block w-fit text-xs underline opacity-50">View chapter source</a>
          </footer>
        </article>
      </div>
      {settings && <div className="absolute inset-0 z-30 bg-black/45" onClick={() => setSettings(false)}>
        <aside onClick={(event) => event.stopPropagation()} className="safe-bottom absolute inset-x-0 bottom-0 rounded-t-4xl border-t border-ink-600 bg-ink-900 p-5 text-fog-100 shadow-lift lg:inset-x-auto lg:right-5 lg:top-20 lg:bottom-auto lg:w-96 lg:rounded-3xl lg:border">
          <div className="flex items-center justify-between"><h2 className="font-display text-lg font-bold">Reading settings</h2><button onClick={() => setSettings(false)} className="grid h-9 w-9 place-items-center rounded-full hover:bg-ink-700"><IcX width={18} /></button></div>
          <label className="mt-5 block text-xs text-fog-400">Text size <span className="float-right">{prefs.size}px</span><input className="mt-2 w-full accent-accent" type="range" min="15" max="28" step="1" value={prefs.size} onChange={(event) => updatePrefs({ size: Number(event.target.value) })} /></label>
          <label className="mt-5 block text-xs text-fog-400">Line height <span className="float-right">{prefs.lineHeight.toFixed(2)}</span><input className="mt-2 w-full accent-accent" type="range" min="1.4" max="2.2" step="0.05" value={prefs.lineHeight} onChange={(event) => updatePrefs({ lineHeight: Number(event.target.value) })} /></label>
          <label className="mt-5 block text-xs text-fog-400">Reading width <span className="float-right">{prefs.width}px</span><input className="mt-2 w-full accent-accent" type="range" min="520" max="980" step="20" value={prefs.width} onChange={(event) => updatePrefs({ width: Number(event.target.value) })} /></label>
          <div className="mt-5"><p className="mb-2 text-xs text-fog-400">Theme</p><div className="grid grid-cols-3 gap-2">{(['dark', 'paper', 'sepia'] as ReaderTheme[]).map((theme) => <button key={theme} onClick={() => updatePrefs({ theme })} className={`rounded-2xl border px-3 py-4 text-xs capitalize ${prefs.theme === theme ? 'border-accent text-accent' : 'border-ink-600'}`} style={{ background: themeStyle[theme].background, color: themeStyle[theme].color }}>{theme}</button>)}</div></div>
        </aside>
      </div>}
      {error && payload && <div className="absolute bottom-5 left-1/2 z-40 w-[min(90vw,32rem)] -translate-x-1/2 rounded-2xl border border-red-400/30 bg-red-950/95 px-4 py-3 text-sm text-red-100 shadow-lift">{error}</div>}
    </div>
  );
}

function ReaderRoute() {
  const params = useSearchParams();
  const { user } = useAuth();
  // Query-string navigation reuses the static page; mount fresh state for each account/chapter.
  return <ReaderContent key={`${user?.id}:${params.get('novelId')}:${params.get('chapterId')}`} />;
}

export default function NovelReaderPage() {
  return <Suspense fallback={<div className="grid h-screen-d place-items-center bg-ink-950 text-fog-400">Opening reader…</div>}><ReaderRoute /></Suspense>;
}
