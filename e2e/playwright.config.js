import { defineConfig } from '@playwright/test';

// Expects the app to be running already (docker compose up, or npm run dev
// in backend/ and frontend/). Override with E2E_BASE_URL.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
});
