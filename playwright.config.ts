import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: {
    timeout: 20_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI === 'true' ? [['list'], ['github']] : [['list']],
  use: {
    headless: true,
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
});
