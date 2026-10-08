/**
 * Builds the icons and launch screens the stores require, in assets/, from the brand SVGs in
 * public/. `npx @capacitor/assets generate` then turns these into every size Android and iOS want.
 *
 *   node scripts/app-assets.mjs
 *
 * Android draws its icon as a foreground layer over a background layer and may crop the corners
 * into a circle or a squircle depending on the phone, so the foreground gets generous padding.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const out = (f) => path.join(root, 'assets', f);
const DARK = '#1A1A1A';

await fs.mkdir(path.join(root, 'assets'), { recursive: true });

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome' });
const page = await browser.newPage();

const dataUrl = async (file) =>
  'data:image/svg+xml;base64,' + (await fs.readFile(path.join(root, 'public', file))).toString('base64');
const iconSvg = await dataUrl('syncrobeat-icon.svg');
const logoSvg = await dataUrl('syncrobeat-logo.svg');

/** Renders one square PNG: `art` at `fill` of the side, centred on `bg` ('none' for transparent). */
async function square(file, size, art, { bg, fill }) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;` +
      `background:${bg === 'none' ? 'transparent' : bg}">` +
      `<img src="${art}" style="width:${fill * 100}%;max-height:${fill * 100}%;object-fit:contain">` +
      `</body>`
  );
  await page.waitForTimeout(120);
  await page.screenshot({ path: out(file), omitBackground: bg === 'none' });
}

// The icon as the stores show it, and the two layers Android composes itself
await square('icon-only.png', 1024, iconSvg, { bg: DARK, fill: 1 });
await square('icon-background.png', 1024, iconSvg, { bg: DARK, fill: 0 });
await square('icon-foreground.png', 1024, iconSvg, { bg: 'none', fill: 0.62 });

// Launch screen. The wordmark is wide, so it takes a modest share of a square that gets cropped
// to whatever shape the device screen is.
await square('splash.png', 2732, logoSvg, { bg: DARK, fill: 0.42 });
await fs.copyFile(out('splash.png'), out('splash-dark.png'));

await browser.close();
console.log('App store assets written to assets/');
