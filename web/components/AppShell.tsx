'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { runSmartOffline } from '@/lib/offlineSync';
import { flushNovelProgress } from '@/lib/novels/storage';
import { BottomNav } from './BottomNav';
import { TopNav } from './TopNav';
import { DownloadsIndicator } from './DownloadsIndicator';
import { LoginScreen } from './LoginScreen';
import { CinematicFX } from './CinematicFX';
import { PageTransition } from './PageTransition';
import { CommandPalette, usePaletteHotkeys } from './CommandPalette';
import { Mark } from './Brand';

function Splash() {
  return (
    <div className="flex min-h-screen-d items-center justify-center">
      <div className="animate-pulse-soft">
        <Mark size={56} />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const path = usePathname();
  const [palette, setPalette] = useState(false);
  // Ctrl/Cmd+K or "/" anywhere in the app (reader keeps its own keys; palette skipped there)
  usePaletteHotkeys(setPalette, status === 'authed' && !path.startsWith('/reader') && !path.startsWith('/novels/read'));

  // smart offline: keep favorites' latest unread chapters downloaded
  const so = user?.settings?.smartOffline;
  useEffect(() => {
    if (status !== 'authed' || !so?.enabled) return;
    const go = () => runSmartOffline(so.perSeries || 3).catch(() => {});
    const t = setTimeout(go, 2500);
    const onVis = () => { if (document.visibilityState === 'visible') go(); };
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(t); window.removeEventListener('online', go); document.removeEventListener('visibilitychange', onVis); };
  }, [status, so?.enabled, so?.perSeries]);

  // Novel progress is an account-scoped IndexedDB outbox. Flush in the foreground because this works on
  // iOS as well as browsers with Background Sync, and because auth restoration has established the owner.
  useEffect(() => {
    if (status !== 'authed' || !user?.id) return;
    const go = () => { void flushNovelProgress(); };
    const timer = window.setTimeout(go, 900);
    const onVisible = () => { if (document.visibilityState === 'visible') go(); };
    window.addEventListener('online', go);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearTimeout(timer); window.removeEventListener('online', go); document.removeEventListener('visibilitychange', onVisible); };
  }, [status, user?.id]);

  if (status === 'loading') return <Splash />;
  if (status === 'anon') return <LoginScreen />;

  const immersive = path.startsWith('/reader') || path.startsWith('/novels/read');
  if (immersive) return <>{children}</>;

  return (
    <>
      <CinematicFX />
      <TopNav onSearchFocus={() => setPalette(true)} />
      <main className="shell relative z-[1] pb-28 lg:pb-12">
        <PageTransition>{children}</PageTransition>
      </main>
      <BottomNav />
      {/* Renders nothing unless something is downloading or has failed. */}
      <DownloadsIndicator />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </>
  );
}
