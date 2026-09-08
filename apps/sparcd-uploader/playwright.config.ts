import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: 'features/steps/**/*.ts',
  outputDir: 'features/.features-gen',
  tags: 'not @manual and not @cross-tool',
  missingSteps: 'fail-on-gen',
});

export default defineConfig({
  testDir,
  fullyParallel: true,
  workers: 3,
  retries: process.env.CI ? 2 : 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5311',
    headless: true,
    timezoneId: 'America/New_York',
    locale: 'en-US',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --port 5311 --strictPort',
    url: 'http://localhost:5311/sparcd-exploration/uploader/',
    reuseExistingServer: false,
    timeout: 120_000,
    // The dev-only endpoint prefill would otherwise override the "remembered
    // from the previous connection" prefill these scenarios assert on.
    env: { VITE_SPARCD_S3_ENDPOINT: '' },
  },
});
