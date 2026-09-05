'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { IcBookmark, IcDownload, IcSparkle } from '@/components/icons';

export function NovelHeader() {
  const params = useSearchParams();
  const view = params.get('view') || 'discover';
  const tabs = [
    { id: 'discover', href: '/novels', label: 'Discover', Icon: IcSparkle },
    { id: 'library', href: '/novels?view=library', label: 'Library', Icon: IcBookmark },
    { id: 'offline', href: '/novels?view=offline', label: 'Offline', Icon: IcDownload },
  ];
  return (
    <header className="safe-top px-4 pt-6 lg:px-0 lg:pt-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/" className="text-xs font-semibold uppercase tracking-[.22em] text-accent">Miaoyomi · Novels</Link>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight lg:text-5xl">Read beyond the panels.</h1>
          <p className="mt-2 max-w-xl text-sm text-fog-400">Browse published sources, open a chapter immediately, and keep selected prose on this device.</p>
        </div>
        <Link href="/library" className="chip">Switch to manga</Link>
      </div>
      <nav className="mt-6 flex gap-2 border-b border-ink-700 pb-3">
        {tabs.map(({ id, href, label, Icon }) => (
          <Link key={id} href={href} className={`chip ${view === id ? 'chip-active' : ''}`}>
            <Icon width={16} height={16} />{label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
