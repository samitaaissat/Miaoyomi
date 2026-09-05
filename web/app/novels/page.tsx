'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { novelsApi, novelErrorMessage } from '@/lib/novels/client';
import { normalizeFilters, serializeFilters } from '@/lib/novels/filters';
import { cacheNovelDetail, listOfflineNovels } from '@/lib/novels/storage';
import type { EngineSource, NovelCard as NovelCardType } from '@/lib/novels/types';
import { NovelCard } from '@/components/novels/NovelCard';
import { NovelFilters } from '@/components/novels/NovelFilters';
import { NovelHeader } from '@/components/novels/NovelHeader';
import { IcRefresh, IcSearch, IcWifiOff } from '@/components/icons';

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="card col-span-full px-5 py-12 text-center"><p className="font-display text-lg font-semibold">{title}</p><p className="mx-auto mt-2 max-w-md text-sm text-fog-400">{text}</p></div>;
}

function SourceManager({ sources }: { sources: EngineSource[] }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => novelsApi.setSource(id, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['novel-sources'] }),
  });
  if (!isAdmin) return null;
  return (
    <details className="card mt-8 p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-fog-200">Manage novel sources</summary>
      <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {sources.map((source) => (
          <div key={source.id} className="rounded-2xl border border-ink-700 bg-ink-900/70 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><p className="truncate text-sm font-semibold">{source.name}</p><p className="text-xs uppercase text-fog-500">{source.lang} · v{source.version}</p></div>
              <button type="button" disabled={!source.supported || mutation.isPending}
                onClick={() => mutation.mutate({ id: source.id, enabled: !source.enabled })}
                className={`chip shrink-0 text-xs ${source.enabled ? 'chip-active' : ''} disabled:cursor-not-allowed disabled:opacity-40`}>
                {source.enabled ? 'Enabled' : 'Enable'}
              </button>
            </div>
            {!source.supported && <p className="mt-2 text-xs leading-relaxed text-amber-300">{source.reason || 'This plugin needs a capability this server does not provide.'}</p>}
          </div>
        ))}
      </div>
      {mutation.isError && <p className="mt-3 text-sm text-red-300">{novelErrorMessage(mutation.error)}</p>}
    </details>
  );
}

function DiscoverView() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['novel-sources', user?.id], queryFn: novelsApi.sources, retry: false });
  const sources = data?.sources ?? [];
  const enabledSources = sources.filter((source) => source.enabled && source.supported);
  const languages = [...new Set(enabledSources.map((source) => source.lang))].sort();
  const [language, setLanguage] = useState('all');
  const available = enabledSources.filter((source) => language === 'all' || source.lang === language);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const scopedSources = sourceIds.length ? available.filter((source) => sourceIds.includes(source.id)) : available;
  const selected = sourceIds.length === 1 ? scopedSources[0] : undefined;
  const [mode, setMode] = useState<'popular' | 'latest'>('popular');
  const supportsLatest = scopedSources.some((source) => source.supportsLatest);
  const browseMode = supportsLatest ? mode : 'popular';
  const [searchText, setSearchText] = useState('');
  const [query, setQuery] = useState('');
  const definitions = useMemo(() => normalizeFilters(selected?.filters), [selected?.filters]);
  const [sourceFilterValues, setSourceFilterValues] = useState<Record<string, Record<string, unknown>>>({});
  const filterValues = selected ? sourceFilterValues[selected.id] ?? {} : {};
  const setFilterValues = (values: Record<string, unknown>) => {
    if (selected) setSourceFilterValues((current) => ({ ...current, [selected.id]: values }));
  };
  const serialized = useMemo(() => serializeFilters(definitions, filterValues), [definitions, filterValues]);
  const scope = { sourceIds, lang: language };
  const listing = useInfiniteQuery({
    queryKey: ['novel-listing', user?.id, scope, scopedSources.map((source) => source.id), query, browseMode, query ? null : serialized],
    initialPageParam: { page: 1, cursor: undefined as string | undefined },
    queryFn: ({ pageParam }) => query
      ? novelsApi.search(scope, query, pageParam.page, pageParam.cursor)
      : novelsApi.browse(scope, browseMode, pageParam.page, serialized, pageParam.cursor),
    getNextPageParam: (last) => last.hasMore ? { page: last.page + 1, cursor: last.nextCursor } : undefined,
    enabled: scopedSources.length > 0,
    retry: false,
  });
  const items = [...new Map((listing.data?.pages.flatMap((page) => page.items) ?? []).map((novel) => [JSON.stringify([novel.sourceId, novel.path]), novel])).values()];
  const failures = listing.data?.pages.at(-1)?.errors ?? [];
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));

  if (isLoading) return <div className="grid grid-cols-2 gap-4 pt-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">{Array.from({ length: 7 }).map((_, index) => <div key={index} className="skeleton aspect-[2/3] rounded-2xl" />)}</div>;
  if (error) return <div className="pt-8"><Empty title="Novel sources are unavailable" text={novelErrorMessage(error)} /><button onClick={() => refetch()} className="btn-ghost mx-auto mt-4 flex"><IcRefresh width={17} />Retry</button></div>;

  return (
    <div className="px-4 pb-10 lg:px-0">
      <div className="hide-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 py-5 lg:mx-0 lg:px-0">
        <button onClick={() => setLanguage('all')} className={`chip ${language === 'all' ? 'chip-active' : ''}`}>All languages</button>
        {languages.map((lang) => <button key={lang} onClick={() => setLanguage(lang)} className={`chip uppercase ${language === lang ? 'chip-active' : ''}`}>{lang}</button>)}
      </div>
      {enabledSources.length ? (
        <>
          <form onSubmit={(event) => { event.preventDefault(); setQuery(searchText.trim()); }} className="flex flex-wrap gap-2">
            <label className="relative min-w-0 flex-1">
              <IcSearch width={18} className="absolute left-3 top-3 text-fog-500" />
              <input aria-label="Search novels" className="field max-w-none pl-10" value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder={selected ? `Search ${selected.name}` : 'Search novels'} />
            </label>
            <button className="btn-accent px-4" type="submit">Search</button>
            {query && <button className="btn-ghost px-4" type="button" onClick={() => { setQuery(''); setSearchText(''); }}>Clear</button>}
          </form>
          {!query && (
            <div className="my-5 flex gap-2">
              <button className={`chip ${browseMode === 'popular' ? 'chip-active' : ''}`} onClick={() => setMode('popular')}>Popular</button>
              {supportsLatest && <button className={`chip ${browseMode === 'latest' ? 'chip-active' : ''}`} onClick={() => setMode('latest')}>Latest</button>}
            </div>
          )}
          <NovelFilters definitions={definitions} values={filterValues} onChange={setFilterValues} sources={enabledSources} sourceIds={sourceIds} onSourcesChange={setSourceIds} searching={!!query} />
          {failures.length > 0 && <div role="status" className="card mb-5 border-amber-400/20 p-4 text-sm text-amber-200">
            <p className="font-semibold">{items.length ? 'Some sources could not answer' : 'Sources could not answer'}</p>
            <ul className="mt-2 space-y-1 text-xs text-fog-400">{failures.map((failure) => <li key={failure.sourceId}>{failure.sourceName || sourceNames.get(failure.sourceId) || failure.sourceId}: {failure.message}</li>)}</ul>
            <button type="button" className="mt-3 text-xs font-semibold text-accent" disabled={listing.isFetching} onClick={() => listing.refetch()}>{listing.isFetching ? 'Retrying…' : 'Retry sources'}</button>
          </div>}
          {listing.isLoading ? (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">{Array.from({ length: 7 }).map((_, index) => <div key={index} className="skeleton aspect-[2/3] rounded-2xl" />)}</div>
          ) : listing.error && !items.length ? (
            <><Empty title="Novel discovery could not refresh" text={novelErrorMessage(listing.error)} /><button type="button" className="btn-ghost mx-auto mt-4 flex" disabled={listing.isFetching} onClick={() => listing.refetch()}><IcRefresh width={17} />Retry</button></>
          ) : items.length ? (
            <>
              <p className="mb-3 text-xs uppercase tracking-[.18em] text-fog-500">{query ? `Results for “${query}”` : browseMode}</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">
                {items.map((novel) => <NovelCard key={JSON.stringify([novel.sourceId, novel.path])} novel={novel} sourceName={sourceNames.get(novel.sourceId) || novel.sourceId} fromSource />)}
              </div>
            </>
          ) : failures.length ? <Empty title="No titles available yet" text="Retry the sources above or adjust your filters to browse other sources." />
            : <Empty title="No novels found" text="No titles match these filters. Try another search or include more sources." />}
          {listing.error && items.length > 0 && <p role="alert" className="mt-5 text-center text-sm text-amber-200">{novelErrorMessage(listing.error)}</p>}
          {listing.hasNextPage && <button className="btn-ghost mx-auto mt-8 flex" disabled={listing.isFetching} onClick={() => listing.fetchNextPage()}>{listing.isFetchingNextPage ? 'Loading…' : listing.isFetchNextPageError ? 'Retry loading more' : 'Load more'}</button>}
        </>
      ) : (
        <Empty title="No enabled novel source" text="An administrator can enable a compatible source below. Sources that need unsupported browser or server features remain visible with their reason." />
      )}
      <SourceManager sources={sources} />
    </div>
  );
}

function LibraryView() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['novel-library', user?.id], queryFn: novelsApi.library, retry: false });
  useEffect(() => { query.data?.items.forEach((item) => void cacheNovelDetail(item, user?.id).catch(() => {})); }, [query.data, user?.id]);
  const items = query.data?.items ?? [];
  return <div className="px-4 py-7 lg:px-0">
    {query.isLoading ? <p className="text-sm text-fog-400">Opening your novel library…</p>
      : query.error ? <Empty title="Library could not refresh" text={`${novelErrorMessage(query.error)} Downloaded chapters are still available in Offline.`} />
      : items.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">{items.map((novel) => <NovelCard key={novel.id} novel={novel as NovelCardType} progress={novel.progress?.position} />)}</div>
      : <Empty title="Your novel shelf is empty" text="Save a title from its details page and it will appear here with your reading position." />}
  </div>;
}

function OfflineView() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['novel-offline', user?.id], queryFn: listOfflineNovels });
  const items = query.data ?? [];
  return <div className="px-4 py-7 lg:px-0">
    <div className="mb-5 flex items-center gap-2 text-sm text-fog-400"><IcWifiOff width={18} />Available without a connection for this account</div>
    {items.length ? <div className="grid grid-cols-2 gap-x-4 gap-y-7 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7">{items.map((novel) => <div key={novel.novelId}><NovelCard novel={{ id: novel.novelId, sourceId: '', path: '', title: novel.title }} /><p className="mt-1 text-xs text-fog-500">{novel.downloadedChapters} chapter{novel.downloadedChapters === 1 ? '' : 's'} downloaded</p></div>)}</div>
      : <Empty title="No downloaded novel chapters" text="Open a chapter, then use Download in the reader. Downloads stay private to the account that saved them." />}
  </div>;
}

function NovelRoot() {
  const view = useSearchParams().get('view') || 'discover';
  return <div className="min-h-screen-d"><NovelHeader />{view === 'library' ? <LibraryView /> : view === 'offline' ? <OfflineView /> : <DiscoverView />}</div>;
}

export default function NovelsPage() {
  return <Suspense fallback={<div className="min-h-screen-d p-8 text-fog-400">Opening novels…</div>}><NovelRoot /></Suspense>;
}
