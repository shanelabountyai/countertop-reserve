import { defineConfig, devices } from '@playwright/test';

// e2e runs against a PRODUCTION build (CLAUDE.md "The gate") — a dev server
// is not the artifact that ships. E2E_DEV=1 restores the dev server for
// stack traces when debugging one spec; never for the sweep.
//
// 3500 is this repo's port and it is the DEFAULT here, not an env var. Two
// projects both defaulting to the same port fail silently, because
// reuseExistingServer adopts whatever is already listening and the suite
// then tests the wrong app.
const PORT = Number(process.env.PORT ?? 3500);
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // NOT fullyParallel, and workers: 1. Every spec shares one app instance
  // and one local Postgres test database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: { baseURL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.E2E_DEV ? 'npm run dev:test' : 'npm run e2e:server',
    cwd: '../..',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // A cold production build blows past the 120s default, which is sized
    // for a dev server's near-instant start.
    timeout: 300_000,
  },
});
