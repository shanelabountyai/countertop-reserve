// `npm run db:seed:demo` — runs the capstone service against the database in
// DATABASE_URL and prints its ledger, so the floor view and the report at
// :3500 have a real Friday dinner on them.
//
// The same function the capstone test asserts against (`runSeededService`),
// so the demo and the fixture can never drift apart.

import { runSeededService, SERVICE_DAY } from './capstone';
import { mockProvider } from './messages';
import { loadReport } from './report';
import { resetDatabaseForDemoSeed } from './testing/index';
import { TIMEZONE } from './capstone';

const percent = (r: { count: number; of: number; rate: number | null }) =>
  r.rate === null ? 'no data' : `${Math.round(r.rate * 100)}% (${r.count} of ${r.of})`;

async function main(): Promise<void> {
  // Refuses any host but a local one unless SEED_ALLOW_HOST names it
  // exactly — this never runs against a deployed database by accident.
  // Deliberately NOT the test-suite guard: wiping the demo database is the
  // point here, and the test guard exists to stop exactly that.
  await resetDatabaseForDemoSeed();
  const { provider, sent } = mockProvider();
  const ledger = await runSeededService(provider);
  const report = await loadReport({ from: SERVICE_DAY, to: SERVICE_DAY }, TIMEZONE);

  console.log(`Seeded ${SERVICE_DAY}: ${report.totals.booked} covers booked, ${report.totals.seated} seated.`);
  console.log(`  no-show  confirmed ${percent(report.noShowByConfirmation.confirmed)} · never confirmed ${percent(report.noShowByConfirmation.unconfirmed)}`);
  console.log(`  released ${percent(report.release)} · waitlist converted ${percent(report.waitlist)}`);
  const { queued, sent: ok, deferred, dropped, drops } = ledger.messages;
  console.log(`  texts    ${queued} queued = ${ok} sent + ${deferred} deferred + ${dropped} dropped${drops.length ? ` (${drops.map((d) => `${d.kind}: ${d.reason}`).join(', ')})` : ''}`);
  console.log(`  provider accepted ${sent.length}`);
  console.log(`\nOpen http://localhost:3500/host?day=${SERVICE_DAY} and http://localhost:3500/host/report?from=${SERVICE_DAY}`);
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    void import('./index').then(({ prisma }) => prisma.$disconnect());
  });
