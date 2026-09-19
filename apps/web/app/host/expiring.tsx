'use client';

// Shows its children for `ms`, then removes them — the Undo button's 5
// seconds (P0-9). `ms` is computed by the server from its own clock; this
// only counts it down, so a skewed tablet clock cannot stretch the window.
// The server enforces the window regardless (lifecycle `revert`).
import { useEffect, useState } from 'react';

export function Expiring({ ms, children }: { ms: number; children: React.ReactNode }) {
  const [live, setLive] = useState(ms > 0);
  useEffect(() => {
    const t = setTimeout(() => setLive(false), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return live ? children : null;
}
