// The four table states, as the board draws them (V-016, restyled in V-018).
//
// It lives beside the board rather than inside it so `/host/design` renders
// the same object the floor does: a token that drifts shows up on the sheet
// instead of being argued about.
import type { TableState } from '@reserve/core';

export const STATE: Record<TableState, { label: string; className: string; badge: string; carries: string }> = {
  free: { label: 'Free', className: 'border-green-800 bg-green-50', badge: 'bg-green-800 text-white', carries: 'its free-until, and the window in minutes' },
  occupied: { label: 'Occupied', className: 'border-ink bg-white', badge: 'bg-ink text-white', carries: 'who is on it, since when, expected clear' },
  reserved_soon: { label: 'Reserved', className: 'border-amber-500 bg-amber-50', badge: 'bg-amber-900 text-white', carries: 'a hold inside the horizon, not yet seated' },
  blocked: { label: 'Blocked', className: 'border-dashed border-stone-500 bg-stone-100', badge: 'bg-stone-600 text-white', carries: 'the unit that took it, named' },
};

export const TABLE_STATES = Object.keys(STATE) as TableState[];
