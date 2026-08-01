import { test, expect } from '@playwright/test';

const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

test('login: valid credentials reach dashboard', async ({ page }) => {
  const steps = { clicks: 0 };
  await page.goto('/');
  await page.fill('#email', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('.login-btn'); steps.clicks++;
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
  test.info().annotations.push({ type: 'steps', description: `${steps.clicks} click(s) to dashboard` });
});

test('login: invalid password shows clear error, not silent failure', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', EMAIL);
  await page.fill('#pw', 'definitely-wrong-password');
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.click('.login-btn');
  await expect(page.locator('#login-error')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#app')).toBeHidden();
  expect(consoleErrors, 'invalid login should not throw console errors').toEqual([]);
});

test('login: empty fields do not silently proceed', async ({ page }) => {
  await page.goto('/');
  await page.click('.login-btn');
  await page.waitForTimeout(1500);
  await expect(page.locator('#app')).toBeHidden();
});
