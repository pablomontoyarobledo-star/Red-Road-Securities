import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './flows',
  reporter: [['list'], ['json', { outputFile: './results/flow-results.json' }]],
  use: {
    baseURL: process.env.BASE_URL || 'https://red-road-securities.vercel.app',
    screenshot: 'only-on-failure',
  },
});
