// Rasterize the existing brand for native launcher icons. No new artwork.
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
const root = path.resolve(import.meta.dirname, '..');
const source = 'data:image/png;base64,' + (await fs.readFile(path.join(root, 'public/syncrobeat-icon-1024.png'))).toString('base64');
const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome' });
try {
  const page = await browser.newPage();
  async function png(file, size, foreground = false) {
    const data = await page.evaluate(async ({ source, size, foreground }) => {
      const img = new Image(); img.src = source; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!foreground) { ctx.fillStyle = '#0b0b0b'; ctx.fillRect(0,0,size,size); }
      const width = foreground ? size * 0.61 : size;
      ctx.drawImage(img, (size-width)/2, (size-width)/2, width, width);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, size, foreground });
    await fs.writeFile(path.join(root, file), Buffer.from(data,'base64'));
  }
  for (const [density, size, adaptive] of [['mdpi',48,108],['hdpi',72,162],['xhdpi',96,216],['xxhdpi',144,324],['xxxhdpi',192,432]]) {
    const dir = `android/app/src/main/res/mipmap-${density}`;
    await png(`${dir}/ic_launcher.png`,size);
    await png(`${dir}/ic_launcher_round.png`,size);
    await png(`${dir}/ic_launcher_foreground.png`,adaptive,true);
  }
  await png('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',1024);
  async function splash(file) {
    const existing = 'data:image/png;base64,' + (await fs.readFile(path.join(root,file))).toString('base64');
    const data = await page.evaluate(async ({ source, existing }) => {
      const old = new Image(); old.src = existing; await old.decode();
      const img = new Image(); img.src = source; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width=old.width; canvas.height=old.height;
      const ctx=canvas.getContext('2d'); ctx.fillStyle='#0b0b0b'; ctx.fillRect(0,0,canvas.width,canvas.height);
      const size = Math.min(canvas.width,canvas.height)*0.28;
      ctx.drawImage(img,(canvas.width-size)/2,(canvas.height-size)/2,size,size);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, existing });
    await fs.writeFile(path.join(root,file),Buffer.from(data,'base64'));
  }
  for (const dir of await fs.readdir(path.join(root,'android/app/src/main/res'))) {
    if (!dir.startsWith('drawable')) continue;
    const file=`android/app/src/main/res/${dir}/splash.png`;
    if (await fs.access(path.join(root,file)).then(()=>true,()=>false)) await splash(file);
  }
  for (const file of await fs.readdir(path.join(root,'ios/App/App/Assets.xcassets/Splash.imageset'))) {
    if (file.endsWith('.png')) await splash(`ios/App/App/Assets.xcassets/Splash.imageset/${file}`);
  }
} finally { await browser.close(); }
