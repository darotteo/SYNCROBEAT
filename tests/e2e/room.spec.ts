import { test, expect, Browser, Page } from '@playwright/test';
import {
  installProbes,
  statusText,
  expectPulseAdvancing,
  clicksBetween,
  pageNow,
  joinRoom,
  createSetlistOnStartScreen,
  newRoomCode,
  syncError,
} from './helpers';

async function newPage(browser: Browser, contextOptions: object): Promise<Page> {
  const context = await browser.newContext(contextOptions);
  await installProbes(context);
  return context.newPage();
}

test('band rehearsal: prepared setlist, roles, shared pulse in sync, tempo and song changes, cues', async ({ browser, contextOptions }) => {
  const room = newRoomCode();
  const drummer = await newPage(browser, contextOptions);
  const guitar = await newPage(browser, contextOptions);

  // The drummer prepares a named setlist before entering
  await drummer.goto('/');
  await createSetlistOnStartScreen(drummer, 'Ensayo viernes', '1. Intro - 120\n2. Balada (voz sola) 90\n3. Final, 140 bpm');
  await expect(drummer.getByLabel('Elegir setlist')).toHaveValue(/setlist-/);
  await joinRoom(drummer, { room, name: 'Ana', instrument: 'Batería' });
  await expect(drummer.getByText('Ensayo viernes')).toBeVisible();
  await expect(drummer.getByText('Tema 1 de 3')).toBeVisible();

  // A guitarist joins through the invite link: drums are locked for them
  await guitar.goto(`/?room=${room}`);
  await expect(guitar.getByRole('button', { name: /Batería/ })).toBeDisabled();
  await expect(guitar.getByText('Esta sala ya tiene baterista')).toBeVisible();
  await joinRoom(guitar, { room, name: 'Beto', instrument: 'Guitarra' });
  await expect(guitar.getByText('Ensayo viernes')).toBeVisible();
  await expect(guitar.getByText('Ana (batería) controla el tempo.')).toBeVisible();
  await expect(guitar.getByRole('button', { name: 'Iniciar' })).toHaveCount(0);
  await expect(guitar.getByRole('button', { name: 'Sumar 5 BPM' })).toHaveCount(0);

  // Start: both screens follow the pulse, and the clicks they schedule coincide
  await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
  await drummer.getByRole('button', { name: 'Iniciar' }).click();
  await expectPulseAdvancing(drummer);
  await expectPulseAdvancing(guitar);
  await expect(guitar.getByText('Sonando')).toBeVisible();
  const from = await pageNow(drummer);
  await drummer.waitForTimeout(4500);
  const a = (await clicksBetween(drummer, from, from + 4000)).sort((x, y) => x - y);
  const b = (await clicksBetween(guitar, from + 250, from + 3750)).sort((x, y) => x - y);
  expect(a.length).toBeGreaterThanOrEqual(7);
  expect(b.length).toBeGreaterThanOrEqual(6);
  const worst = Math.max(...syncError(a, b));
  expect(worst, `devices out of sync by ${worst.toFixed(1)} ms`).toBeLessThan(10);

  // Tempo change reaches the band
  await drummer.getByRole('button', { name: 'Sumar 5 BPM' }).click();
  await expect(guitar.locator('span.tabular-nums').filter({ hasText: /^125$/ })).toBeVisible();
  await expect(drummer.getByRole('button', { name: /Guardar 125 BPM en «Intro»/ })).toBeVisible();

  // Next song: settings of song 2 for everyone
  await drummer.getByRole('button', { name: 'Tema siguiente' }).click();
  await expect(guitar.getByText('Tema 2 de 3')).toBeVisible();
  await expect(guitar.locator('span.tabular-nums').filter({ hasText: /^90$/ }).first()).toBeVisible();

  // Cues
  await guitar.getByRole('button', { name: 'Avisos' }).click();
  await guitar.getByRole('button', { name: 'Vamos al estribillo' }).click();
  await expect(drummer.getByRole('status').filter({ hasText: 'Vamos al estribillo' })).toBeVisible();
  await guitar.getByPlaceholder('Escribí un aviso…').fill('Bajamos medio tono');
  await guitar.getByRole('button', { name: 'Enviar aviso' }).click();
  await expect(drummer.getByRole('status').filter({ hasText: 'Bajamos medio tono' })).toBeVisible();

  // Stop
  await drummer.getByRole('button', { name: 'Detener' }).click();
  await expect(statusText(drummer)).toHaveText('Detenido');
  await expect(statusText(guitar)).toHaveText('Detenido');
  await expect(guitar.getByText('Detenido').first()).toBeVisible();

  await drummer.context().close();
  await guitar.context().close();
});

test('a dropped connection reconnects by itself and the click keeps the room phase', async ({ browser, contextOptions }) => {
  const room = newRoomCode();
  const drummer = await newPage(browser, contextOptions);
  const bass = await newPage(browser, contextOptions);
  await joinRoom(drummer, { room, name: 'Dani', instrument: 'Batería' });
  await joinRoom(bass, { room, name: 'Eva', instrument: 'Bajo' });
  await drummer.getByRole('button', { name: 'Sin cuenta' }).click();
  await drummer.getByRole('button', { name: 'Iniciar' }).click();
  await expectPulseAdvancing(bass);

  // Cut the bassist's socket (like a phone switching networks)
  await bass.evaluate(() => (window as any).__sockets.forEach((s: WebSocket) => s.close()));
  await expect(bass.getByText(/Reconectando con la sala/)).toBeVisible();
  // The pulse continues locally while reconnecting
  await expectPulseAdvancing(bass);
  await expect(bass.getByText(/Reconectando con la sala/)).toBeHidden({ timeout: 10_000 });
  await expect(drummer.getByRole('button', { name: /Banda · 2/ })).toBeVisible();

  const from = await pageNow(drummer);
  await drummer.waitForTimeout(3500);
  const a = (await clicksBetween(drummer, from, from + 3000)).sort((x, y) => x - y);
  const b = (await clicksBetween(bass, from + 250, from + 2750)).sort((x, y) => x - y);
  expect(b.length).toBeGreaterThanOrEqual(4);
  expect(Math.max(...syncError(a, b))).toBeLessThan(10);

  // The drummer still controls the room after the bassist reconnected
  await drummer.getByRole('button', { name: 'Detener' }).click();
  await expect(statusText(bass)).toHaveText('Detenido');
  await drummer.context().close();
  await bass.context().close();
});

test('the drummer can switch the room setlist from inside; musicians cannot edit it', async ({ browser, contextOptions }) => {
  const room = newRoomCode();
  const drummer = await newPage(browser, contextOptions);
  const keys = await newPage(browser, contextOptions);
  await drummer.goto('/');
  await createSetlistOnStartScreen(drummer, 'Lista A', 'Uno - 100\nDos - 110');
  await createSetlistOnStartScreen(drummer, 'Lista B', 'Tres - 130');
  await drummer.getByLabel('Elegir setlist').selectOption({ label: 'Lista A · 2 temas' });
  await joinRoom(drummer, { room, name: 'Caro', instrument: 'Batería' });
  await joinRoom(keys, { room, name: 'Fede', instrument: 'Teclado' });
  await expect(keys.getByText('Lista A')).toBeVisible();
  await expect(keys.getByRole('button', { name: 'Agregar tema' })).toHaveCount(0);
  await expect(keys.getByRole('button', { name: 'Cambiar' })).toHaveCount(0);

  await drummer.getByRole('button', { name: 'Cambiar' }).click();
  await drummer.getByRole('dialog', { name: 'Cambiar setlist' }).getByRole('button', { name: /Lista B/ }).click();
  await expect(keys.getByText('Lista B')).toBeVisible();
  await expect(keys.getByRole('listitem').getByText('Tres')).toBeVisible();
  await expect(keys.locator('span.tabular-nums').filter({ hasText: /^130$/ }).first()).toBeVisible();

  // Edits by the drummer are synced back to the saved setlist on their device
  await drummer.getByRole('button', { name: 'Agregar tema' }).click();
  await drummer.getByLabel('Nombre del tema').fill('Cuatro');
  await drummer.getByRole('button', { name: 'Agregar tema' }).last().click();
  await expect(keys.getByText('Cuatro')).toBeVisible();
  const saved = await drummer.evaluate(() => JSON.parse(localStorage.getItem('syncbeat_setlist_library') || '[]'));
  expect(saved.find((l: any) => l.name === 'Lista B').songs.map((s: any) => s.title)).toEqual(['Tres', 'Cuatro']);

  await drummer.context().close();
  await keys.context().close();
});
