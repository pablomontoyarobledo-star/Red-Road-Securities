import { test, expect } from '@playwright/test';

test('flow: switching language updates login UI without error', async ({ page }) => {
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto('/');
  await expect(page.locator('#login-subtitle')).toHaveText('Investor portal');

  await page.click('#login-lang-es');
  await expect(page.locator('#login-subtitle')).toHaveText('Portal del inversor');

  await page.click('#login-lang-en');
  await expect(page.locator('#login-subtitle')).toHaveText('Investor portal');

  expect(consoleErrors, 'language switch should not throw console errors').toEqual([]);
});
