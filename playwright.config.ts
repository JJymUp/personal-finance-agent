import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

function resolveChromiumExecutable(): string | undefined {
  const fromEnv = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  return undefined;
}

const executablePath = resolveChromiumExecutable();

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    // Runs built server + built dist-h5 in strict mock mode (never calls paid cloud models in CI E2E)
    command: 'FORCE_MOCK=true PORT=4173 node apps/server/dist/index.js',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
