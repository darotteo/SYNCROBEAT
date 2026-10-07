import { Page, BrowserContext, expect } from '@playwright/test';

/**
 * Injected before the app loads. Records every sound the app schedules in the real Web Audio
 * engine (oscillators and voice samples, not the silent keep-alive loop) with the epoch time it
 * will sound at, and keeps a handle on every WebSocket so tests can cut the connection.
 */
export async function installProbes(context: BrowserContext) {
  await context.addInitScript(() => {
    const w = window as any;
    w.__whens = [] as number[]; // each click on the AudioContext clock (seconds, exactly as scheduled)
    w.__sockets = [] as WebSocket[];

    /**
     * One audio-clock → wall-clock mapping, measured now from the median of several readings.
     * Reading it once per click instead would import the browser's own occasional one-buffer
     * (~21 ms) error into the measurement and blame the app for it.
     */
    w.__mapping = async () => {
      const ctx: AudioContext = w.__ctx;
      const samples: { d: number; c: number; p: number }[] = [];
      for (let i = 0; i < 15; i++) {
        const ts = ctx.getOutputTimestamp?.();
        if (ts?.contextTime && ts?.performanceTime) {
          samples.push({ d: ts.performanceTime / 1000 - ts.contextTime, c: ts.contextTime, p: ts.performanceTime });
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      if (!samples.length) throw new Error('no output timestamps available');
      samples.sort((a, b) => a.d - b.d);
      const m = samples[Math.floor(samples.length / 2)];
      return { contextTime: m.c, performanceTime: m.p, timeOrigin: performance.timeOrigin };
    };
    // Track the audio graph so a click whose path to the speaker was cut (cancelled) is known
    const outputs = new WeakMap<AudioNode, AudioNode[]>();
    const cutAt = new WeakMap<AudioNode, number>();
    const connect = AudioNode.prototype.connect as any;
    AudioNode.prototype.connect = function (this: AudioNode, dest: any, ...rest: any[]) {
      if (dest instanceof AudioNode) outputs.set(this, [...(outputs.get(this) || []), dest]);
      return connect.call(this, dest, ...rest);
    } as any;
    const disconnect = AudioNode.prototype.disconnect as any;
    AudioNode.prototype.disconnect = function (this: AudioNode, ...args: any[]) {
      if (args.length === 0 && !cutAt.has(this)) cutAt.set(this, (this.context as AudioContext).currentTime);
      return disconnect.apply(this, args);
    } as any;
    const sources: { node: AudioNode; when: number }[] = [];
    /** True if the click scheduled at `when` was cut before it could sound. */
    const cancelled = (node: AudioNode, when: number, depth = 0): boolean => {
      const cut = cutAt.get(node);
      if (cut !== undefined && cut <= when) return true;
      if (depth > 4) return false;
      const outs = outputs.get(node) || [];
      return outs.length > 0 && outs.every((o) => cancelled(o, when, depth + 1));
    };
    // Each click that will really be heard: `when` on the audio clock (exact, as the engine
    // scheduled it) and `epoch` on the shared wall clock (for comparing two devices).
    w.__audible = () => {
      const audible = new Set<number>();
      for (const s of sources) if (!cancelled(s.node, s.when)) audible.add(s.when);
      return [...audible].sort((a, b) => a - b);
    };
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (this: AudioScheduledSourceNode, when = 0, ...rest: any[]) {
      const isClick = this instanceof OscillatorNode || (this instanceof AudioBufferSourceNode && !this.loop);
      if (isClick && when > 0) sources.push({ node: this, when });
      // One click uses several oscillators at the same instant: record it once
      if (isClick && when > 0 && w.__whens[w.__whens.length - 1] !== when) {
        w.__ctx = this.context;
        w.__whens.push(when);
      }
      return (start as any).call(this, when, ...rest);
    };
    const NativeWS = window.WebSocket;
    w.WebSocket = class extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        w.__sockets.push(this);
      }
    };
  });
}

export const statusText = (page: Page) =>
  page.locator('span').filter({ hasText: /^(Detenido|Arrancando…|Cuenta · \d+|Tiempo \d+)$/ }).first();

/** Waits until the on-screen beat shows "Tiempo n" for at least two different n (the pulse moves). */
export async function expectPulseAdvancing(page: Page) {
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const t = await statusText(page).textContent();
        if (t?.startsWith('Tiempo')) seen.add(t);
        return seen.size;
      },
      { timeout: 10_000, intervals: [50] }
    )
    .toBeGreaterThanOrEqual(2);
}

/** Epoch ms of the clicks that will be heard within a window. */
export async function clicksBetween(page: Page, from: number, to: number): Promise<number[]> {
  return (await audibleClicks(page)).filter((t) => t >= from && t <= to);
}

/**
 * Intervals (ms) between consecutive clicks that are actually heard, measured on the page's own
 * audio clock: this is exactly what the scheduler asked the hardware to play.
 */
export async function audioIntervals(page: Page): Promise<number[]> {
  const whens: number[] = await page.evaluate(() => (window as any).__audible());
  return whens.slice(1).map((t, i) => (t - whens[i]) * 1000);
}

export const clickCount = (page: Page): Promise<number> => page.evaluate(() => (window as any).__whens.length);

/**
 * Epoch ms at which every click that will really be heard leaves the speaker (cancelled ones
 * excluded), sorted. All clicks are converted with one mapping measured now, so the comparison
 * between two devices reflects the schedule, not momentary noise in the browser's own reporting.
 */
export async function audibleClicks(page: Page): Promise<number[]> {
  return page.evaluate(async () => {
    const w = window as any;
    const m = await w.__mapping();
    return w.__audible().map((when: number) => m.timeOrigin + m.performanceTime + (when - m.contextTime) * 1000);
  });
}

/**
 * How far apart (ms) two devices place the same beat. Only the window both lists cover is compared:
 * each page schedules up to two seconds ahead and the two lists are read one after the other, so the
 * trailing clicks of one have no counterpart yet and would score a whole beat.
 */
export function syncError(a: number[], b: number[]): number[] {
  if (a.length < 2 || b.length < 2) throw new Error(`not enough clicks to compare (${a.length} vs ${b.length})`);
  const from = Math.max(a[0], b[0]);
  const to = Math.min(a[a.length - 1], b[b.length - 1]);
  // Only the last stretch: each list is converted with a mapping measured at the end, so clicks
  // much older than that carry the audio/system clock drift accumulated since they were played.
  const inWindow = b.filter((t) => t >= Math.max(from, to - 20_000) && t <= to);
  if (inWindow.length < 2) throw new Error('the two click lists barely overlap');
  return inWindow.map((t) => Math.min(...a.map((x) => Math.abs(x - t))));
}

/** Scrolls an element clear of the sticky header before clicking it. */
export async function clickBelowHeader(page: Page, locator: ReturnType<Page['getByRole']>) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, -120));
  await locator.click();
}

export const pageNow =(page: Page): Promise<number> => page.evaluate(() => performance.timeOrigin + performance.now());

export async function joinRoom(page: Page, opts: { room: string; name: string; instrument: 'Batería' | 'Guitarra' | 'Bajo' | 'Teclado' }) {
  await page.goto(`/?room=${opts.room}`);
  await page.getByLabel('Tu nombre').fill(opts.name);
  await page.getByRole('button', { name: new RegExp(opts.instrument) }).click();
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('region', { name: 'Compensación de latencia' })).toBeVisible();
}

export async function createSetlistOnStartScreen(page: Page, name: string, pasted: string) {
  await page.getByRole('button', { name: 'Crear setlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Crear setlist' });
  await dialog.getByPlaceholder('Ej.: Ensayo del viernes').fill(name);
  await dialog.getByRole('button', { name: 'Importar', exact: true }).click();
  const importDialog = page.getByRole('dialog', { name: 'Importar temas' });
  await importDialog.locator('textarea').fill(pasted);
  await importDialog.getByRole('button', { name: /^Importar \(\d+\)$/ }).click();
  await dialog.getByRole('button', { name: 'Guardar setlist' }).click();
  await expect(dialog).toBeHidden();
}

export const newRoomCode = () => `E2E${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
