/**
 * The four things that decide whether SyncroBeat is usable on stage. Everything here measures the
 * real Web Audio schedule of two browsers in one room, not the on-screen pulse.
 *
 * These run two browser engines (see playwright.config.ts). They cannot reproduce a real iPhone's
 * audio session, Bluetooth output latency or a locked screen: that still needs a phone.
 */
import { test, expect, Browser, Page, BrowserContext } from '@playwright/test';
import {
  installProbes,
  joinRoom,
  newRoomCode,
  expectPulseAdvancing,
  audibleClicks,
  statusText,
  syncError,
} from './helpers';

/** Minutes for the long stability run. `SYNC_MINUTES=20 npx playwright test sync` for the full one. */
const LONG_MINUTES = Number(process.env.SYNC_MINUTES) || 3;

/**
 * Two clicks closer together than this are heard as one; past it they start to sound like a flam.
 * The bar is deliberately set at what a musician can hear, not at the best number measured.
 */
const AUDIBLE_MS = 10;
/** A click this far off its own grid is inaudible as unsteadiness. */
const STEADY_MS = 3;

async function newPage(browser: Browser, contextOptions: object): Promise<Page> {
  const context = await browser.newContext(contextOptions);
  await installProbes(context);
  return context.newPage();
}

/**
 * Emulates a phone's connection: added round-trip delay and limited bandwidth, so the two musicians
 * are not on the same network. Clock sync must still work through it.
 */
async function throttle(page: Page, { latencyMs, downKbps = 4000, upKbps = 2000 }: { latencyMs: number; downKbps?: number; upKbps?: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: latencyMs,
    downloadThroughput: (downKbps * 1000) / 8,
    uploadThroughput: (upKbps * 1000) / 8,
  });
  return cdp;
}

test.describe('1. the click must not drift', () => {
  test('a tempo change and a song change keep both devices on the same grid', async ({ browser, contextOptions }) => {
    const room = newRoomCode();
    const drummer = await newPage(browser, contextOptions);
    const other = await newPage(browser, contextOptions);
    await drummer.goto('/');
    await drummer.evaluate(() =>
      localStorage.setItem(
        'syncbeat_setlist_library',
        JSON.stringify([
          {
            id: 'sync-list',
            name: 'Sync',
            songs: [
              { id: 's1', title: 'Uno', bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, subdivision: '1', accentPattern: [2, 1, 1, 1] },
              { id: 's2', title: 'Dos', bpm: 90, timeSignature: { numerator: 3, denominator: 4 }, subdivision: '1', accentPattern: [2, 1, 1] },
            ],
          },
        ])
      )
    );
    await drummer.reload();
    await drummer.getByLabel('Elegir setlist').selectOption({ label: 'Sync · 2 temas' });
    await joinRoom(drummer, { room, name: 'Dru', instrument: 'Batería' });
    await joinRoom(other, { room, name: 'Otro', instrument: 'Guitarra' });
    await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
    await drummer.getByRole('button', { name: 'Iniciar' }).click();
    await expectPulseAdvancing(other);

    await drummer.waitForTimeout(3000);
    await drummer.getByRole('button', { name: 'Sumar 5 BPM' }).click(); // 125
    await drummer.waitForTimeout(3000);
    await drummer.getByRole('button', { name: 'Tema siguiente' }).click(); // 90 BPM, 3/4
    await drummer.waitForTimeout(4000);

    const a = await audibleClicks(drummer);
    const b = await audibleClicks(other);
    expect(b.length).toBeGreaterThan(15);
    const worst = Math.max(...syncError(a, b));
    expect(worst, `devices ${worst.toFixed(1)} ms apart across tempo and song changes`).toBeLessThan(AUDIBLE_MS);

    // And every interval is one of the three tempos: no stray or doubled click
    const periods = [500, 60000 / 125, 60000 / 90];
    for (let i = 1; i < a.length; i++) {
      const gap = a[i] - a[i - 1];
      expect(Math.min(...periods.map((p) => Math.abs(gap - p))), `gap ${gap.toFixed(1)} ms`).toBeLessThan(STEADY_MS);
    }
    await drummer.context().close();
    await other.context().close();
  });

  // Long and engine-independent: running it once is enough, and it would otherwise add
  // LONG_MINUTES to every browser project in the suite.
  test(`stays locked for ${LONG_MINUTES} minutes of continuous playing`, async ({ browser, contextOptions }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'measured once, on the desktop project');
    test.setTimeout(LONG_MINUTES * 60_000 + 120_000);
    const room = newRoomCode();
    const drummer = await newPage(browser, contextOptions);
    const other = await newPage(browser, contextOptions);
    await joinRoom(drummer, { room, name: 'Dru', instrument: 'Batería' });
    await joinRoom(other, { room, name: 'Otro', instrument: 'Bajo' });
    await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
    await drummer.getByRole('button', { name: 'Iniciar' }).click();
    await expectPulseAdvancing(other);

    const started = Date.now();
    while (Date.now() - started < LONG_MINUTES * 60_000) {
      await drummer.waitForTimeout(20_000);
      const a = await audibleClicks(drummer);
      const b = await audibleClicks(other);
      const worst = Math.max(...syncError(a, b));
      const minute = ((Date.now() - started) / 60_000).toFixed(1);
      expect(worst, `after ${minute} min the devices are ${worst.toFixed(1)} ms apart`).toBeLessThan(AUDIBLE_MS);
    }

    // The whole run must sit on one 500 ms grid: no slow drift and no accumulated error
    const a = await audibleClicks(drummer);
    const spanBeats = Math.round((a[a.length - 1] - a[0]) / 500);
    expect(spanBeats).toBeGreaterThan(LONG_MINUTES * 100);
    const drift = Math.abs(a[a.length - 1] - a[0] - spanBeats * 500);
    expect(drift, `the click drifted ${drift.toFixed(1)} ms over ${LONG_MINUTES} minutes`).toBeLessThan(AUDIBLE_MS);
    await drummer.context().close();
    await other.context().close();
  });
});

test.describe('2. losing the internet', () => {
  test('the click keeps going offline, reconnects by itself and comes back in phase', async ({ browser, contextOptions }) => {
    const room = newRoomCode();
    const drummer = await newPage(browser, contextOptions);
    const other = await newPage(browser, contextOptions);
    await joinRoom(drummer, { room, name: 'Dru', instrument: 'Batería' });
    await joinRoom(other, { room, name: 'Otro', instrument: 'Teclado' });
    await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
    await drummer.getByRole('button', { name: 'Iniciar' }).click();
    await expectPulseAdvancing(other);
    await drummer.waitForTimeout(1500);

    // Really offline, like a phone losing signal (not just closing the socket)
    const cdp = await other.context().newCDPSession(other);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await other.evaluate(() => (window as any).__sockets.forEach((s: WebSocket) => s.close()));

    const duringStart = (await audibleClicks(other)).length;
    await other.waitForTimeout(6000);
    const during = await audibleClicks(other);
    expect(during.length - duringStart, 'the click must not stop while offline').toBeGreaterThanOrEqual(8);
    // Still on the same grid as before the cut
    for (let i = 1; i < during.length; i++) expect(Math.abs(during[i] - during[i - 1] - 500)).toBeLessThan(STEADY_MS);
    await expect(other.getByText(/Reconectando con la sala/)).toBeVisible();
    await expect(statusText(other)).toHaveText(/Tiempo \d/);

    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await expect(other.getByText(/Reconectando con la sala/)).toBeHidden({ timeout: 20_000 });
    await expect(drummer.getByRole('button', { name: /Banda · 2/ })).toBeVisible();

    await drummer.waitForTimeout(4000);
    const a = await audibleClicks(drummer);
    const b = (await audibleClicks(other)).filter((t) => t > a[0]);
    const worst = Math.max(...syncError(a, b));
    expect(worst, `after reconnecting the devices are ${worst.toFixed(1)} ms apart`).toBeLessThan(AUDIBLE_MS);

    // The drummer still commands the room afterwards
    await drummer.getByRole('button', { name: 'Detener' }).click();
    await expect(statusText(other)).toHaveText('Detenido');
    await drummer.context().close();
    await other.context().close();
  });
});

test.describe('3. each musician on a different network', () => {
  test('venue wifi and mobile data stay in sync through slow, uneven connections', async ({ browser, contextOptions }) => {
    const room = newRoomCode();
    const drummer = await newPage(browser, contextOptions);
    const other = await newPage(browser, contextOptions);
    await joinRoom(drummer, { room, name: 'Dru', instrument: 'Batería' });
    await joinRoom(other, { room, name: 'Otro', instrument: 'Guitarra' });

    // Venue wifi: 30 ms. Mobile data: 180 ms round trip, slow upload.
    await throttle(drummer, { latencyMs: 30 });
    await throttle(other, { latencyMs: 180, downKbps: 1200, upKbps: 600 });
    // Let the clock estimate settle over the slow link
    await other.waitForTimeout(6000);

    await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
    await drummer.getByRole('button', { name: 'Iniciar' }).click();
    await expectPulseAdvancing(other);
    await drummer.waitForTimeout(8000);

    const a = await audibleClicks(drummer);
    const b = await audibleClicks(other);
    expect(b.length).toBeGreaterThan(8);
    const worst = Math.max(...syncError(a, b));
    expect(worst, `across different networks the devices are ${worst.toFixed(1)} ms apart`).toBeLessThan(AUDIBLE_MS);

    // A tempo change still reaches the slow device and lands on the same grid
    await drummer.getByRole('button', { name: 'Restar 5 BPM' }).click();
    await expect(other.locator('span.tabular-nums').filter({ hasText: /^115$/ })).toBeVisible({ timeout: 10_000 });
    await drummer.waitForTimeout(5000);
    const a2 = await audibleClicks(drummer);
    const b2 = (await audibleClicks(other)).filter((t) => t > a[a.length - 1]);
    expect(Math.max(...syncError(a2, b2))).toBeLessThan(AUDIBLE_MS);
    await drummer.context().close();
    await other.context().close();
  });
});

test.describe('4. headphone calibration is remembered', () => {
  test('survives closing the app and coming back another day', async ({ browser, contextOptions }) => {
    const context: BrowserContext = await browser.newContext(contextOptions);
    await installProbes(context);
    const page = await context.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
    const panel = page.getByRole('region', { name: 'Compensación de latencia' });
    await panel.getByRole('button', { name: 'Desbloquear ajuste' }).click();
    for (let i = 0; i < 7; i++) await panel.getByRole('button', { name: 'Sumar 10 ms' }).click();
    await panel.getByRole('button', { name: 'Listo, bloquear' }).click();
    await expect(panel.getByText('+70 ms')).toBeVisible();

    // Same device, a new session days later: the browser keeps the storage, the app re-reads it
    const stored = await context.storageState();
    await page.close();
    const laterContext = await browser.newContext({ ...contextOptions, storageState: stored });
    await installProbes(laterContext);
    const later = await laterContext.newPage();
    await later.goto('/');
    await later.getByRole('button', { name: 'Practicar sin conexión' }).click();
    await expect(later.getByRole('region', { name: 'Compensación de latencia' }).getByText('+70 ms')).toBeVisible();

    // And it is still applied to the audio, not just shown on screen
    await later.getByRole('button', { name: 'Sin cuenta' }).click();
    await later.getByRole('button', { name: 'Iniciar' }).click();
    await expectPulseAdvancing(later);
    await later.waitForTimeout(2500);
    const clicks = await audibleClicks(later);
    expect(clicks.length).toBeGreaterThan(3);
    for (let i = 1; i < clicks.length; i++) expect(Math.abs(clicks[i] - clicks[i - 1] - 500)).toBeLessThan(STEADY_MS);

    // It is personal: joining a room does not push it to anybody else
    await expect(later.getByRole('region', { name: 'Compensación de latencia' }).getByText('Solo en este dispositivo')).toBeVisible();
    await context.close();
    await laterContext.close();
  });
});
