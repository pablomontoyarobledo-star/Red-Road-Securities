import { chromium } from 'playwright';
import fs from 'fs';
import routes from './routes.json' with { type: 'json' };

const BASE_URL = process.env.BASE_URL || 'https://red-road-securities.vercel.app';
const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
};

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
  const outDir = './scripts/audit/results/screenshots';
  fs.mkdirSync(outDir, { recursive: true });

  for (const [vpName, vp] of Object.entries(VIEWPORTS)) {
    for (const route of routes) {
      const context = await browser.newContext({ viewport: vp });
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
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${outDir}/${route.name}-${vpName}.png`, fullPage: true });
        console.log(`captured ${route.name}-${vpName}`);
      } catch (e) {
        console.error(`FAILED ${route.name}-${vpName}: ${e.message}`);
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();
})();
