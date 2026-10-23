import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
    headless: process.env.PLAYWRIGHT_HEADED !== '1',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      slowMo: Number(process.env.PLAYWRIGHT_SLOW_MO ?? 0)
    }
  },
  outputDir: './out/playwright-results',
  webServer: {
    command: 'npm run build:webview && node test/e2e/server.cjs',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
