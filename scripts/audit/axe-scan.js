import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
import routes from './routes.json' with { type: 'json' };

const BASE_URL = process.env.BASE_URL || 'https://red-road-securities.vercel.app';
const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

async function login(page) {
  await page.goto(BASE_URL + '/', { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('.login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 20000 });
  await page.waitForTimeout(800);
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  let authedPage = null;

  for (const route of routes) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      if (!route.authRequired) {
        await page.goto(BASE_URL + route.path, { waitUntil: 'networkidle' });
      } else {
        await login(page);
        if (route.name === 'settings') {
          await page.click('.logout-btn');
          await page.waitForSelector('#settings-screen', { state: 'visible', timeout: 10000 }).catch(() => {});
        } else if (route.name === 'admin') {
          await page.click('#admin-nav-btn');
          await page.waitForTimeout(500);
        } else if (route.view) {
          await page.click(`#ptab-${route.view}`);
          await page.waitForTimeout(600);
        }
      }
      const scan = await new AxeBuilder({ page }).analyze();
      results.push({ route: route.name, violations: scan.violations });
      console.log(`scanned ${route.name}: ${scan.violations.length} violations`);
    } catch (e) {
      results.push({ route: route.name, error: e.message });
      console.error(`FAILED ${route.name}: ${e.message}`);
    } finally {
      await context.close();
    }
  }

  fs.mkdirSync('./scripts/audit/results', { recursive: true });
  fs.writeFileSync('./scripts/audit/results/axe-results.json', JSON.stringify(results, null, 2));
  await browser.close();
})();
