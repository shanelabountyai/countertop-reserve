import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts'],
    // CLAUDE.md: the unit suite must produce identical results under any
    // process TZ. CI runs it twice (TZ=UTC and TZ=Pacific/Kiritimati) —
    // pacing-bucket and quiet-hours-boundary tests are exactly what a
    // UTC-only CI would hide. Locally: `TZ=Pacific/Kiritimati npm test`.

    // Test FILES that touch Postgres share ONE local database and each
    // cleans its own tables. Vitest parallelizes files by default, so two
    // DB-touching files can truncate rows the other is mid-transaction on.
    // Serializing files removes the race class outright; the suite is fast
    // enough that it costs nothing.
    fileParallelism: false,
  },
});
