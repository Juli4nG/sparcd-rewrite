import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'features/tag-before-upload.feature',
  steps: 'features/steps/**/*.ts',
  outputDir: 'features/.features-gen-cross-tool',
  tags: '@cross-tool',
  missingSteps: 'fail-on-gen',
});

export default defineConfig({
  testDir,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 150_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5310',
    headless: true,
    timezoneId: 'America/New_York',
    locale: 'en-US',
    trace: 'off',
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'pnpm dev --port 5321 --strictPort',
      url: 'http://localhost:5321/sparcd-exploration/uploader/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_SPARCD_S3_ENDPOINT: '' },
    },
    {
      command: 'pnpm --dir ../sparcd-tagger dev --port 5322 --strictPort',
      url: 'http://localhost:5322/sparcd-exploration/tagger/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_SPARCD_S3_ENDPOINT: '' },
    },
    {
      command: 'pnpm --dir ../sparcd-dev-proxy dev',
      url: 'http://localhost:5310/sparcd-exploration/uploader/',
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SPARCD_UPLOADER_DEV_URL: 'http://localhost:5321',
        SPARCD_TAGGER_DEV_URL: 'http://localhost:5322',
      },
    },
  ],
});
