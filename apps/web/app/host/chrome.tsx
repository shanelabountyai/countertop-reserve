// The staff chrome (V-018): one black bar across every host screen.
//
// It is the page's <header>, so there is exactly one banner per screen and
// the live count a host reads at a glance — free tables, unconfirmed
// bookings — sits in it rather than being repeated per page.
import type { ReactNode } from 'react';

const TABS = [
  { href: '/host', label: 'Book' },
  { href: '/host/board', label: 'Tables' },
  { href: '/host/hours', label: 'Hours' },
  { href: '/host/report', label: 'Report' },
  { href: '/host/design', label: 'Design' },
] as const;

export type Tab = (typeof TABS)[number]['label'];

export function Chrome({ active, status, clock }: { active: Tab; status?: ReactNode; clock?: string }) {
  return (
    <header className="flex flex-wrap items-stretch bg-ink text-white">
      <p className="flex min-h-16 items-center px-6 text-xl font-extrabold tracking-wider uppercase">Firebird · Reserve</p>
      <nav aria-label="Host" className="flex items-stretch">
        {TABS.map((t) =>
          t.label === active ? (
            <span key={t.href} aria-current="page" className="flex min-h-16 items-center bg-surface px-5 text-lg font-extrabold text-ink">
              {t.label}
            </span>
          ) : (
            <a key={t.href} href={t.href} className="flex min-h-16 items-center px-5 text-lg font-bold text-stone-200 hover:bg-stone-800 hover:text-white">
              {t.label}
            </a>
          ),
        )}
      </nav>
      <p className="ms-auto flex min-h-16 flex-wrap items-center gap-5 px-6 text-lg font-bold tabular-nums">
        {status}
        {clock ? <span>{clock}</span> : null}
      </p>
    </header>
  );
}
