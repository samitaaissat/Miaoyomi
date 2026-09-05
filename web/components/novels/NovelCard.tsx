'use client';
import Link from 'next/link';
import type { NovelCard as NovelCardType } from '@/lib/novels/types';
import { Img } from '@/components/ui';

export function NovelCard({ novel, progress, sourceName, fromSource = false }: { novel: NovelCardType; progress?: number; sourceName?: string; fromSource?: boolean }) {
  const href = novel.id && !fromSource
    ? `/novels/title?id=${encodeURIComponent(novel.id)}`
    : `/novels/title?sourceId=${encodeURIComponent(novel.sourceId)}&path=${encodeURIComponent(novel.path)}`;
  return (
    <Link href={href} className="group min-w-0">
      <div className="relative aspect-[2/3] overflow-hidden rounded-2xl border border-ink-700 bg-ink-850 shadow-lift">
        {novel.cover ? (
          <Img src={novel.cover} alt="" className="h-full w-full" imgClassName="group-hover:scale-[1.03]" />
        ) : (
          <div className="grid h-full place-items-center bg-[radial-gradient(circle_at_30%_20%,rgb(var(--accent)/.32),transparent_55%),linear-gradient(145deg,#171721,#09090d)] font-display text-5xl font-bold text-fog-600">
            {novel.title.slice(0, 1).toUpperCase()}
          </div>
        )}
        {progress != null && (
          <div className="absolute inset-x-0 bottom-0 h-1.5 bg-black/60">
            <div className="h-full bg-accent" style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%` }} />
          </div>
        )}
      </div>
      <h3 className="mt-2 line-clamp-2 text-sm font-semibold leading-snug text-fog-100 transition group-hover:text-accent">{novel.title}</h3>
      {sourceName && <p className="mt-1 truncate text-xs text-fog-500">{sourceName}</p>}
    </Link>
  );
}
