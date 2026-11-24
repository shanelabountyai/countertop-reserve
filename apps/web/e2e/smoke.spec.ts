import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// V-001 has no features to exercise. What this proves is the harness itself:
// the production build serves on 3500, and the axe wiring is live from
// commit one rather than bolted on after the floor view exists —
// accessibility added late is accessibility argued about late.
test('the app serves on this repo port, and the front door is the booking flow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Firebird Kitchen' })).toBeVisible();
  await page.getByRole('link', { name: 'Book a table' }).click();
  await expect(page.getByRole('heading', { name: 'Book a table' })).toBeVisible();
});

test('the landing page has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// Scorecard K7 / SEC-05: the built app sends the security headers on every
// response, pages and the sign-in alike.
test('every response carries the security headers', async ({ request }) => {
  for (const path of ['/', '/book', '/host/login']) {
    const h = (await request.get(path, { maxRedirects: 0 })).headers();
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
    expect(h['strict-transport-security'], path).toContain('max-age=');
  }
});
