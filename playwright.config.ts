import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT) || 3123;
// Point the suite at a deployed server instead of a local build:
//   E2E_BASE_URL=https://syncrobeat.onrender.com npx playwright test sync --project=desktop
const DEPLOYED = process.env.E2E_BASE_URL;
// Uses the Chrome installed on the machine (no browser download). Set E2E_CHANNEL=msedge or
// E2E_CHANNEL=chromium (after `npx playwright install chromium`) to switch.
const channel = process.env.E2E_CHANNEL || 'chrome';
const launchOptions = { args: ['--autoplay-policy=no-user-gesture-required'] };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: DEPLOYED || `http://127.0.0.1:${PORT}`,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    locale: 'es-AR',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel, launchOptions } },
    // Phone-sized layout with touch events (Chrome engine; real Android still needs a device)
    { name: 'mobile', use: { ...devices['Pixel 7'], channel, launchOptions } },
    // WebKit is the engine Safari and every iPhone browser use. It catches Safari-specific bugs in
    // JavaScript, CSS and Web Audio, but it is NOT an iPhone: audio session, silent switch,
    // Bluetooth latency and the locked screen only behave for real on the device.
    { name: 'safari-engine', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone-engine', use: { ...devices['iPhone 14'] } },
  ],
  webServer: DEPLOYED
    ? undefined
    : {
        command: 'node node_modules/tsx/dist/cli.mjs server.ts --prod',
        url: `http://127.0.0.1:${PORT}/api/health`,
        env: { PORT: String(PORT), NODE_ENV: 'production' },
        reuseExistingServer: false,
        timeout: 60_000,
      },
});
