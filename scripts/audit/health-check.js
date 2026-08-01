import { chromium } from 'playwright';
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

  for (const route of routes) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors = [];
    const failedRequests = [];

    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('response', res => {
      if (res.status() >= 400) {
        failedRequests.push({ url: res.url(), status: res.status() });
      }
    });
    page.on('requestfailed', req => {
      failedRequests.push({ url: req.url(), status: 'FAILED', reason: req.failure()?.errorText });
    });

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
      await page.waitForTimeout(500);
      results.push({ route: route.name, consoleErrors, failedRequests });
      console.log(`checked ${route.name}: ${consoleErrors.length} console errors, ${failedRequests.length} failed requests`);
    } catch (e) {
      results.push({ route: route.name, error: e.message, consoleErrors, failedRequests });
      console.error(`FAILED ${route.name}: ${e.message}`);
    } finally {
      await context.close();
    }
  }

  fs.mkdirSync('./scripts/audit/results', { recursive: true });
  fs.writeFileSync('./scripts/audit/results/health-check.json', JSON.stringify(results, null, 2));
  await browser.close();
})();
