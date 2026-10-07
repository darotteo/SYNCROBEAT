import { test, expect } from '@playwright/test';
import {
  installProbes,
  statusText,
  expectPulseAdvancing,
  audioIntervals,
  clickCount,
  audibleClicks,
  clickBelowHeader,
  pageNow,
} from './helpers';

/** A click this far off the grid is inaudible; measured deviation is well under 1 ms. */
const STEADY_MS = 3;

test.beforeEach(async ({ context }) => {
  await installProbes(context);
});

test('local practice: count-in, pulse advances (never stuck in "Arrancando"), steady clicks, stop', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await expect(statusText(page)).toHaveText('Detenido');

  await page.getByRole('button', { name: 'Iniciar' }).click();
  await expect(statusText(page)).toHaveText(/Cuenta · \d/, { timeout: 3000 });
  await expectPulseAdvancing(page);

  // Real Web Audio scheduling: 120 BPM → one click every 500 ms, no gaps or doubles
  await page.waitForTimeout(4000);
  const intervals = await audioIntervals(page);
  expect(intervals.length).toBeGreaterThanOrEqual(6);
  for (const gap of intervals) expect(Math.abs(gap - 500)).toBeLessThan(STEADY_MS);

  await page.getByRole('button', { name: 'Detener' }).click();
  await expect(statusText(page)).toHaveText('Detenido');
  // Clicks already queued are cancelled; nothing new may be scheduled after stopping
  const countAtStop = await clickCount(page);
  await page.waitForTimeout(1500);
  expect(await clickCount(page)).toBe(countAtStop);
});

test('tempo controls: buttons, keyboard, tap tempo, meter and subdivision', async ({ page, isMobile }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  const bpm = page.locator('span.tabular-nums').filter({ hasText: /^\d{2,3}$/ }).first();
  await expect(bpm).toHaveText('120');
  await page.getByRole('button', { name: 'Sumar 5 BPM' }).click();
  await page.getByRole('button', { name: 'Restar 1 BPM' }).click();
  await expect(bpm).toHaveText('124');

  if (!isMobile) {
    await page.locator('body').click({ position: { x: 5, y: 300 } });
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Shift+ArrowDown');
    await expect(bpm).toHaveText('120');
    await page.keyboard.press('Space');
    await expectPulseAdvancing(page);
    await page.keyboard.press('Space');
    await expect(statusText(page)).toHaveText('Detenido');
  }

  // Tap tempo: the app averages the taps it actually received, so compare against their real times
  const tap = page.getByRole('button', { name: 'Tap' });
  const taps: number[] = [];
  for (let i = 0; i < 4; i++) {
    await tap.click();
    taps.push(await pageNow(page));
    if (i < 3) await page.waitForTimeout(600);
  }
  const expected = 60_000 / ((taps[3] - taps[0]) / 3);
  expect(Math.abs(Number(await bpm.textContent()) - expected)).toBeLessThanOrEqual(2);

  await page.getByRole('button', { name: '7/8' }).click();
  await expect(page.getByText('7/8').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Tiempo \d+:/ })).toHaveCount(7);
  await page.getByRole('button', { name: 'Tiempo 1: acentuado' }).click();
  await expect(page.getByRole('button', { name: 'Tiempo 1: normal' })).toBeVisible();
  // The subdivision buttons show a music glyph; the readable name is on the title attribute
  await clickBelowHeader(page, page.getByTitle('Tresillos'));
  await expect(page.getByTitle('Tresillos')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Tresillos')).toBeVisible();
});

test('a tempo change while playing keeps the pulse steady until the next bar, then the new tempo', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await page.getByRole('button', { name: 'Sin cuenta' }).click();
  await page.getByRole('button', { name: 'Iniciar' }).click();
  await expectPulseAdvancing(page);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Restar 5 BPM' }).click(); // 115 BPM
  await page.waitForTimeout(5000);
  const intervals = await audioIntervals(page);
  // Every gap is either the old (500) or the new (521.7) interval, and it switches exactly once
  const kinds = intervals.map((g) =>
    Math.abs(g - 500) < STEADY_MS ? 'old' : Math.abs(g - 60000 / 115) < STEADY_MS ? 'new' : `bad:${g.toFixed(1)}`
  );
  expect(kinds.filter((k) => k.startsWith('bad'))).toEqual([]);
  expect(kinds.join(',')).toMatch(/^(old,)+(new,?)+$/);
});

test('latency compensation is locked, can be tuned live, cancelled, saved and survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  const panel = page.getByRole('region', { name: 'Compensación de latencia' });
  await expect(panel.getByText('Ajuste bloqueado')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sumar 10 ms' })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Desbloquear ajuste' }).click();
  await panel.getByRole('button', { name: 'Sumar 10 ms' }).click();
  await panel.getByRole('button', { name: 'Sumar 1 ms' }).click();
  await expect(panel.getByLabel('Compensación actual')).toHaveText('+11 ms');
  await panel.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel.getByText('0 ms', { exact: true })).toBeVisible();

  await panel.getByRole('button', { name: 'Desbloquear ajuste' }).click();
  for (let i = 0; i < 3; i++) await panel.getByRole('button', { name: 'Restar 10 ms' }).click();
  await panel.getByRole('button', { name: 'Listo, bloquear' }).click();
  await expect(panel.getByText('-30 ms')).toBeVisible();
  await expect(panel.getByText('Ajuste bloqueado')).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await expect(page.getByRole('region', { name: 'Compensación de latencia' }).getByText('-30 ms')).toBeVisible();

  // Opening audio settings while unlocked cancels the unsaved edit
  await panel.getByRole('button', { name: 'Desbloquear ajuste' }).click();
  await panel.getByRole('button', { name: 'Sumar 10 ms' }).click();
  await page.getByRole('button', { name: 'Ajustes de audio' }).click();
  await page.keyboard.press('Escape');
  await expect(panel.getByText('-30 ms')).toBeVisible();
  await expect(panel.getByText('Ajuste bloqueado')).toBeVisible();
});

test('the personal latency offset really moves the click, and only on this device', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await page.getByRole('button', { name: 'Sin cuenta' }).click();
  await page.getByRole('button', { name: 'Iniciar' }).click();
  await expectPulseAdvancing(page);
  await page.waitForTimeout(1500);
  const before = await audibleClicks(page);

  const panel = page.getByRole('region', { name: 'Compensación de latencia' });
  await panel.getByRole('button', { name: 'Desbloquear ajuste' }).click();
  for (let i = 0; i < 5; i++) await panel.getByRole('button', { name: 'Sumar 10 ms' }).click(); // +50 ms
  await panel.getByRole('button', { name: 'Listo, bloquear' }).click();
  await page.waitForTimeout(2500);

  // Clicks after the change land 50 ms earlier than the unchanged 500 ms grid
  const anchor = before[before.length - 1];
  const after = (await audibleClicks(page)).filter((t) => t > anchor + 600);
  expect(after.length).toBeGreaterThanOrEqual(3);
  for (const t of after) {
    const beats = (t + 50 - anchor) / 500;
    expect(Math.abs(beats - Math.round(beats)) * 500).toBeLessThan(6);
  }
});

test('stage mode opens full screen and closes', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await page.getByTitle(/Modo atril/).click();
  const stage = page.getByText('Modo atril', { exact: true });
  await expect(stage).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(stage).toBeHidden();
});

test('PWA: manifest, service worker, icons and fonts are served', async ({ request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.name).toBe('SyncroBeat');
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  const sw = await request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['cache-control']).toMatch(/no-cache/);
  for (const n of [1, 8]) expect((await request.get(`/voice/es-${n}.wav`)).status()).toBe(200);
  expect((await request.get('/fonts/fonts.css')).status()).toBe(200);
  // Apple: the home-screen icon and the stacked logo must exist
  expect((await request.get('/syncrobeat-apple-touch-icon.png')).status()).toBe(200);
  expect((await request.get('/syncrobeat-logo.svg')).status()).toBe(200);
});
