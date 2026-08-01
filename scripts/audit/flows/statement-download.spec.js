import { test, expect } from '@playwright/test';

const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

test('critical flow: investor downloads monthly statement PDF', async ({ page }) => {
  await page.goto('/');
  await page.fill('#email', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('.login-btn');
  await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });

  let steps = 1; // login click
  await page.click('#ptab-statements'); steps++;
  await expect(page.locator('#stmt-download-btn')).toBeVisible();

  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.click('#stmt-download-btn'); steps++;
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  test.info().annotations.push({ type: 'steps', description: `${steps} clicks from login to downloaded PDF` });
});
