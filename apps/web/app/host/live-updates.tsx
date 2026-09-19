'use client';

// The polling half of P0-9 (Countertop's LiveUpdates). Renders nothing; it
// only decides when the server component should render again. It holds no
// copy of the floor, and it reads no clock to decide anything: the cursor is
// the server's, and the once-a-minute refresh is counted in ticks.
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Fixed at 10s — a floor moves slower than a kitchen queue (CLAUDE.md; WRITEUP caveat). */
const POLL_INTERVAL_MS = 10_000;
/** Elapsed-since-seated is printed in minutes by the server; refresh at that resolution even when nothing changed. */
const TICKS_PER_IDLE_REFRESH = 60_000 / POLL_INTERVAL_MS;

export function LiveUpdates({ cursor }: { cursor: string }) {
  const router = useRouter();

  useEffect(() => {
    let seen = cursor;
    let ticks = 0;
    let stopped = false;

    const poll = async () => {
      // A background tab asks nothing (P0-9).
      if (document.hidden || stopped) return;
      const response = await fetch(`/api/floor-updates?cursor=${encodeURIComponent(seen)}`, { cache: 'no-store' });
      if (!response.ok || stopped) return;
      const update = (await response.json()) as { cursor: string; changed: boolean };
      if (stopped) return;
      seen = update.cursor;
      ticks += 1;
      if (update.changed || ticks >= TICKS_PER_IDLE_REFRESH) {
        ticks = 0;
        router.refresh();
      }
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Coming back to the tab polls at once rather than waiting out the interval.
    document.addEventListener('visibilitychange', poll);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', poll);
    };
  }, [cursor, router]);

  return null;
}
