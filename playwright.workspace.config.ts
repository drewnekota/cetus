import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
export default defineConfig({
  testDir: './tests',
  testMatch: 'workspace-editor.spec.ts',
  outputDir: `${tmpdir()}/cetus-workspace-editor-results`,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:18766', browserName: 'chromium', channel: process.env.CETUS_TEST_BROWSER_CHANNEL },
  webServer: {
    command: 'bun tests/fixtures/serve-workspace-editor.ts',
    url: 'http://127.0.0.1:18766',
  },
});
