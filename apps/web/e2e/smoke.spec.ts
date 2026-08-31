import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// V-001 has no features to exercise. What this proves is the harness itself:
// the production build serves on 3500, and the axe wiring is live from
// commit one rather than bolted on after the floor view exists —
// accessibility added late is accessibility argued about late.
test('the app serves on this repo port', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Countertop Reserve' })).toBeVisible();
});

test('the landing page has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
