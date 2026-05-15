import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  outputDir: 'test-results',

  use: {
    baseURL: process.env.HAICO_BASE_URL || 'http://127.0.0.1:4567',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: 'npm run build && node dist/index.js',
    port: 4567,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      HAICO_PORT: '4567',
      HAICO_DB_PATH: './test-e2e.db',
    },
  },
});
