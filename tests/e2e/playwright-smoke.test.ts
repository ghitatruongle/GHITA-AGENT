// Real browser E2E test against the desktop app's splash.html and dev server.
// Tests actual page load, DOM rendering, and basic UI interactions.
//
// Usage: npx playwright test tests/e2e/playwright-smoke.test.ts

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:1420';

test.describe('Desktop App E2E Smoke Tests', () => {
  test('splash page loads and renders', async ({ page }) => {
    // Test the splash page (used during Tauri startup)
    const splashPath = `${process.cwd()}/apps/desktop/public/splash.html`;
    await page.goto(`file://${splashPath}`);

    // Verify splash renders
    await expect(page).toHaveTitle(/Ghita Agent/i);
  });

  test('index.html loads without errors', async ({ page }) => {
    // Capture console errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(BASE_URL, { timeout: 15000 });

    // Should not have any unhandled exceptions
    expect(errors).toHaveLength(0);
  });

  test('root renders #root element', async ({ page }) => {
    await page.goto(BASE_URL, { timeout: 15000 });

    // Verify the root div exists
    const root = await page.locator('#root');
    await expect(root).toBeVisible();
  });

  test('global styles are applied', async ({ page }) => {
    await page.goto(BASE_URL, { timeout: 15000 });

    // Verify background color from index.html
    const html = await page.locator('html');
    const bgColor = await html.evaluate((el) => window.getComputedStyle(el).backgroundColor);

    // Should not be transparent (index.html sets #0a0a1a)
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgColor).not.toBe('transparent');
  });

  test('font stylesheet is configured', async ({ page }) => {
    await page.goto(BASE_URL, { timeout: 15000 });

    // External font delivery can be unavailable in CI, but the stylesheet must be wired.
    const fontLink = page.locator('link[rel="stylesheet"][href*="fonts.googleapis.com"]');
    await expect(fontLink).toHaveCount(1);
  });

  test('no mixed content warnings', async ({ page }) => {
    await page.goto(BASE_URL, { timeout: 15000 });

    // All resources should use HTTPS or be local
    const links = await page.locator('link[href]').all();
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (href && href.startsWith('http://')) {
        // Localhost is OK for development
        expect(href).toContain('localhost');
      }
    }
  });

  test('performance: page loads within 3 seconds', async ({ page }) => {
    const start = Date.now();
    await page.goto(BASE_URL, { timeout: 15000 });
    const loadTime = Date.now() - start;

    expect(loadTime).toBeLessThan(3000);
  });
});

test.describe('Mobile App E2E (if server running)', () => {
  test.skip(() => !process.env.E2E_MOBILE_URL, 'Mobile E2E disabled (set E2E_MOBILE_URL)');

  test('mobile health endpoint responds', async ({ request }) => {
    const response = await request.get(`${process.env.E2E_MOBILE_URL}/health`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
  });
});
