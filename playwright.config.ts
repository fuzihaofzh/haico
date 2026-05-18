import { defineConfig, devices } from '@playwright/test';

const e2ePort = Number(process.env.HAICO_E2E_PORT || 4599);
const baseURL = process.env.HAICO_BASE_URL || `http://127.0.0.1:${e2ePort}`;
const shouldStartServer = !process.env.HAICO_BASE_URL;
const e2eDbPath = process.env.HAICO_E2E_DB_PATH || './test-e2e.db';

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
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: shouldStartServer ? {
    command: 'npm run build && node dist/index.js',
    url: baseURL,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
    env: {
      HAICO_PORT: String(e2ePort),
      HAICO_HOST: '127.0.0.1',
      HAICO_DB_PATH: e2eDbPath,
      HAICO_NO_AUTH: 'true',
    },
  } : undefined,
});
