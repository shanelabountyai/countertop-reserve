import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:3500';
const OUT = process.argv[2];
const PASSCODE = process.env.STAFF_PASSCODE;
const TOKEN = process.env.MANAGE_TOKEN;

mkdirSync(OUT, { recursive: true });

/**
 * A manage token IS the credential — anyone holding one can change or cancel
 * that booking. This script logged the full URL of every shot, so `/m/<token>`
 * went to stdout and from there into CI logs and terminal scrollback.
 * Screenshot runs are exactly the thing people paste into a chat.
 */
const redact = (url) => url.replace(/\/m\/[\w-]+/g, '/m/<token>');

const shots = [
  { name: '1-book-party', url: '/book' },
  { name: '2-book-times', url: '/book?party=10&day=2026-10-02' },
  { name: '3-manage', url: `/m/${TOKEN}` },
  { name: '4-host-floor', url: '/host?day=2026-10-02' },
  { name: '5-host-hours', url: '/host/hours' },
  { name: '6-host-report', url: '/host/report?from=2026-10-02' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

// One login, reused by the staff shots via the shared context cookie.
await page.goto(`${BASE}/host/login`);
await page.fill('input[type="password"]', PASSCODE);
await page.click('button[type="submit"]');
await page.waitForLoadState('networkidle');

for (const s of shots) {
  await page.goto(`${BASE}${s.url}`);
  await page.waitForLoadState('networkidle');
  // The dev-server badge is not part of the product.
  await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
  await page.screenshot({ path: `${OUT}/${s.name}.png`, fullPage: true });
  console.log(`${s.name}  ${redact(page.url())}`);
}

await browser.close();
