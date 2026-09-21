// The no-show & cover report's one read (P1-1). Thin on purpose: every tally
// lives in `report` in @reserve/core, which is pure and takes no clock.
//
// The history each row carries is the append-only event log, which is the
// only place that remembers a reservation was confirmed before it no-showed.
// Nothing here re-derives it from the current status.

import { parseStatus, report, type Report, type ReportRow, type Status } from '@reserve/core';
import { prisma } from './index';

/** Restaurant-calendar days, inclusive. Days are strings, never a Postgres `date`. */
export type ReportRange = { from: string; to: string };

export async function loadReportRows(range: ReportRange): Promise<ReportRow[]> {
  const rows = await prisma.reservation.findMany({
    where: { businessDay: { gte: range.from, lte: range.to } },
    orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
    select: {
      businessDay: true,
      startAt: true,
      partySize: true,
      status: true,
      createdAt: true,
      events: { select: { toStatus: true }, orderBy: { id: 'asc' } },
    },
  });
  return rows.map((r) => ({
    businessDay: r.businessDay,
    startAt: r.startAt,
    partySize: r.partySize,
    status: parseStatus(r.status),
    createdAt: r.createdAt,
    // A revert appends its own event, so a status reverted away from still
    // shows here — which is right: it did happen, and the log is the record.
    history: dedupe(r.events.map((e) => parseStatus(e.toStatus))),
  }));
}

const dedupe = (statuses: readonly Status[]): Status[] => [...new Set(statuses)];

export async function loadReport(range: ReportRange, timezone: string): Promise<Report> {
  return report(await loadReportRows(range), timezone);
}
