import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
export default defineConfig({
  testDir: './tests',
  testMatch: 'chat-scroll.spec.ts',
  outputDir: `${tmpdir()}/cetus-chat-scroll-results`,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:18765',
    browserName: process.env.CETUS_TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium',
    channel: process.env.CETUS_TEST_BROWSER === 'webkit' ? undefined : process.env.CETUS_TEST_BROWSER_CHANNEL,
    viewport: { width: 900, height: 700 },
  },
  webServer: {
    command: 'bun tests/fixtures/serve-chat-scroll.ts',
    url: 'http://127.0.0.1:18765',
    reuseExistingServer: false,
  },
});
