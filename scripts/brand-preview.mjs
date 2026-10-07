/** Renders every logo / icon on one sheet (brand/preview.png) to check the generated assets. */
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome' });
const page = await browser.newPage();
const img = async (file) => 'data:image/svg+xml;base64,' + (await fs.readFile(file)).toString('base64');
await page.setViewportSize({ width: 900, height: 820 });
await page.setContent(`<body style="margin:0;background:#0b0b0b;padding:30px;display:flex;flex-direction:column;gap:30px;align-items:center">
  <img src="${await img('public/syncrobeat-logo.svg')}" style="width:560px">
  <img src="${await img('public/syncrobeat-logo-horizontal.svg')}" style="width:420px">
  <div style="display:flex;gap:30px">
    <img src="${await img('public/syncrobeat-icon.svg')}" style="width:180px">
    <img src="${await img('brand/syncrobeat-icon-claro.svg')}" style="width:180px">
  </div></body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: 'brand/preview.png' });
await browser.close();
