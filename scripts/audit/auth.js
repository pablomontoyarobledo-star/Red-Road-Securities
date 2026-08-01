const EMAIL = process.env.AUDIT_EMAIL;
const PASSWORD = process.env.AUDIT_PASSWORD;

export async function login(page, baseUrl) {
  await page.goto(baseUrl + '/', { waitUntil: 'networkidle' });
  await page.fill('#email', EMAIL);
  await page.fill('#pw', PASSWORD);
  await page.click('.login-btn');
  await page.waitForSelector('#app', { state: 'visible', timeout: 15000 });
}

export async function goToView(page, viewName) {
  await page.click(`#ptab-${viewName}`);
  await page.waitForTimeout(400);
}

export { EMAIL, PASSWORD };
