/**
 * Builds the SyncroBeat logo and icons from the brand sheet (brand/syncrobeat-lamina.webp).
 * The sheet is a low-resolution presentation, so the shapes are traced to vectors (potrace) and
 * recoloured with the exact palette; every PNG is rendered from those vectors, sharp at any size.
 *
 *   node scripts/brand-assets.mjs
 *
 * Replace the outputs with the designer's original files when they are available.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';
import potrace from 'potrace';

const root = path.resolve(import.meta.dirname, '..');
const sheet = path.join(root, 'brand/syncrobeat-lamina.webp');
const out = (f) => path.join(root, 'public', f);

const PINK = '#FF3B6B';
const ORANGE = '#FF8A3C';
const WHITE = '#FFFFFF';
const DARK = '#1A1A1A';
const SCALE = 4; // Trace an upscaled bitmap: smoother curves from the low-resolution sheet

// Regions of the sheet (source pixels)
const REGIONS = {
  stacked: { x: 222, y: 145, w: 818, h: 462 },
  horizontal: { x: 74, y: 786, w: 508, h: 118 },
  icon: { x: 699, y: 778, w: 158, h: 158 },
};

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || 'chrome' });
const page = await browser.newPage();
await page.setContent('<body style="margin:0;background:transparent"></body>');
const dataUrl = 'data:image/webp;base64,' + (await fs.readFile(sheet)).toString('base64');

/** Returns two black-on-white PNG masks (white strokes / coloured strokes) for a region. */
async function masks(region) {
  return page.evaluate(
    async ({ dataUrl, region, SCALE }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const w = region.w * SCALE;
      const h = region.h * SCALE;
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, region.x, region.y, region.w, region.h, 0, 0, w, h);
      const src = ctx.getImageData(0, 0, w, h).data;
      const make = async (test) => {
        const m = new OffscreenCanvas(w, h);
        const mctx = m.getContext('2d');
        const out = mctx.createImageData(w, h);
        for (let i = 0; i < src.length; i += 4) {
          const v = test(src[i], src[i + 1], src[i + 2]) ? 0 : 255;
          out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
          out.data[i + 3] = 255;
        }
        mctx.putImageData(out, 0, 0);
        const blob = await m.convertToBlob({ type: 'image/png' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(bin);
      };
      return {
        white: await make((r, g, b) => Math.min(r, g, b) > 120 && Math.max(r, g, b) - Math.min(r, g, b) < 45),
        color: await make((r, g, b) => r > 110 && r - g > 35 && r - b > 15),
      };
    },
    { dataUrl, region, SCALE }
  );
}

async function trace(base64) {
  return new Promise((resolve, reject) => {
    const p = new potrace.Potrace();
    p.setParameters({ turdSize: 40, optTolerance: 0.35, alphaMax: 1.0, threshold: 128 });
    p.loadImage(Buffer.from(base64, 'base64'), (err) => {
      if (err) return reject(err);
      const tag = p.getPathTag('#000');
      resolve(tag.match(/ d="([^"]+)"/)[1]);
    });
  });
}

/** Vector paths of one region in a 0..w×0..h coordinate space (source pixels). */
async function shapes(name) {
  const r = REGIONS[name];
  const m = await masks(r);
  return { w: r.w, h: r.h, white: await trace(m.white), color: await trace(m.color) };
}

/** The traced artwork as an SVG group in source-pixel units. */
/** Bounding box of an absolute-coordinate path (potrace output). */
function bbox(d) {
  const n = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

// Pink at the bottom-left of the coloured strokes, orange towards the top-right (as in the sheet)
const gradient = (id, b) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${b.x}" y1="${b.y + b.h}" x2="${b.x + b.w * 0.75}" y2="${b.y}">` +
  `<stop offset="0" stop-color="${PINK}"/><stop offset="0.6" stop-color="${ORANGE}"/><stop offset="1" stop-color="${ORANGE}"/></linearGradient>`;

const art = (s, id, lightColor = WHITE) =>
  `<g transform="scale(${1 / SCALE})"><defs>${gradient(id, bbox(s.color))}</defs>` +
  `<path fill="${lightColor}" fill-rule="evenodd" d="${s.white}"/><path fill="url(#${id})" fill-rule="evenodd" d="${s.color}"/></g>`;

const svgDoc = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

/** Square icon: artwork centred on a background, occupying `fill` of the side. */
function iconSvg(s, { bg, light = WHITE, fill = 0.78, radius = 0 }) {
  const side = 1024;
  const k = (side * fill) / Math.max(s.w, s.h);
  const ox = (side - s.w * k) / 2;
  const oy = (side - s.h * k) / 2;
  return svgDoc(
    side,
    side,
    `<rect width="${side}" height="${side}" rx="${radius}" fill="${bg}"/>` +
      `<g transform="translate(${ox} ${oy}) scale(${k})">${art(s, 'g', light)}</g>`
  );
}

async function png(svg, size, file) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<body style="margin:0;background:transparent">` +
      svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `) +
      `</body>`
  );
  await page.locator('svg').screenshot({ path: out(file), omitBackground: true });
}

const stacked = await shapes('stacked');
const horizontal = await shapes('horizontal');
const icon = await shapes('icon');

await fs.writeFile(out('syncrobeat-logo.svg'), svgDoc(stacked.w, stacked.h, art(stacked, 'g')));
await fs.writeFile(out('syncrobeat-logo-horizontal.svg'), svgDoc(horizontal.w, horizontal.h, art(horizontal, 'g')));
const iconDark = iconSvg(icon, { bg: DARK });
await fs.writeFile(out('syncrobeat-icon.svg'), iconSvg(icon, { bg: DARK, radius: 224 }));
await fs.writeFile(path.join(root, 'brand/syncrobeat-icon-claro.svg'), iconSvg(icon, { bg: WHITE, light: DARK, radius: 224 }));

await png(iconDark, 1024, 'syncrobeat-icon-1024.png'); // App Store / Play Store
await png(iconDark, 512, 'syncrobeat-icon-512.png');
await png(iconDark, 192, 'syncrobeat-icon-192.png');
await png(iconDark, 180, 'syncrobeat-apple-touch-icon.png');
await png(iconDark, 32, 'syncrobeat-favicon-32.png');
await png(iconSvg(icon, { bg: DARK, fill: 0.6 }), 512, 'syncrobeat-maskable-512.png'); // Android safe zone

await browser.close();
console.log('Brand assets written to public/');
