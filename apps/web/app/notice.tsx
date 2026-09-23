// The callout (V-018). The words carry the meaning; the bar, border and tint
// only agree with them — nothing here is legible by colour alone.
import type { ReactNode } from 'react';

const TONE = {
  attention: { box: 'border-amber-500 bg-amber-50 text-amber-900', bar: 'bg-amber-500' },
  danger: { box: 'border-red-700 bg-red-50 text-red-900', bar: 'bg-red-700' },
  fresh: { box: 'border-sky-800 bg-sky-50 text-sky-900', bar: 'bg-sky-700' },
  quiet: { box: 'border-stone-300 bg-stone-50 text-stone-700', bar: 'bg-stone-400' },
} as const;

export function Notice({ tone = 'attention', children }: { tone?: keyof typeof TONE; children: ReactNode }) {
  return (
    <div className={`flex gap-3 border-2 px-4 py-3 font-semibold ${TONE[tone].box}`}>
      <span aria-hidden="true" className={`w-2 shrink-0 self-stretch ${TONE[tone].bar}`} />
      <p>{children}</p>
    </div>
  );
}
