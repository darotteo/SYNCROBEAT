import { test, expect } from '@playwright/test';
import { installProbes, createSetlistOnStartScreen } from './helpers';

test.beforeEach(async ({ context }) => {
  await installProbes(context);
});

test('start screen: create, persist, edit, practise with and delete a named setlist', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Elegir setlist')).toHaveValue('');
  await createSetlistOnStartScreen(page, 'Show sábado', '1. Abre - 128\n2. Lenta (con click suave) 72\n3. Cierre, 150 bpm');
  const picker = page.getByLabel('Elegir setlist');
  await expect(picker.locator('option:checked')).toHaveText('Show sábado · 3 temas');
  await expect(page.getByText('Abre · Lenta · Cierre')).toBeVisible();

  // Survives a reload and stays selected
  await page.reload();
  await expect(page.getByLabel('Elegir setlist').locator('option:checked')).toHaveText('Show sábado · 3 temas');

  // Edit: rename and reorder
  await page.getByRole('button', { name: 'Editar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Editar setlist' });
  await dialog.getByPlaceholder('Ej.: Ensayo del viernes').fill('Show domingo');
  await dialog.getByRole('button', { name: 'Editar Cierre' }).click();
  await dialog.getByRole('button', { name: 'Subir' }).click();
  await dialog.getByRole('button', { name: 'Guardar', exact: true }).click();
  await dialog.getByRole('button', { name: 'Guardar setlist' }).click();
  await expect(page.getByText('Abre · Cierre · Lenta')).toBeVisible();

  // Practise uses the chosen setlist and its first song
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await expect(page.getByText('Show domingo')).toBeVisible();
  await expect(page.getByText('Tema 1 de 3')).toBeVisible();
  await expect(page.locator('span.tabular-nums').filter({ hasText: /^128$/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Tema siguiente' }).click();
  await expect(page.locator('span.tabular-nums').filter({ hasText: /^150$/ }).first()).toBeVisible();

  // Back to the start screen and delete it (two-step confirmation)
  await page.getByRole('button', { name: 'Más opciones' }).click();
  await page.getByRole('button', { name: 'Salir de la práctica' }).click();
  await page.getByRole('button', { name: 'Borrar Show domingo' }).click();
  await page.getByRole('button', { name: 'Confirmar borrado' }).click();
  await expect(page.getByLabel('Elegir setlist')).toHaveValue('');
  await expect(page.getByLabel('Elegir setlist').locator('option')).toHaveCount(1);
});

test('a setlist without a name or songs cannot be saved', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Crear setlist' }).click();
  const dialog = page.getByRole('dialog', { name: 'Crear setlist' });
  const save = dialog.getByRole('button', { name: 'Guardar setlist' });
  await expect(save).toBeDisabled();
  await dialog.getByPlaceholder('Ej.: Ensayo del viernes').fill('Vacía');
  await expect(save).toBeDisabled();
  await dialog.getByRole('button', { name: 'Agregar tema' }).click();
  await dialog.getByLabel('Nombre del tema').fill('Solo uno');
  await dialog.getByRole('button', { name: 'Agregar tema' }).last().click();
  await expect(save).toBeEnabled();
  await dialog.getByPlaceholder('Ej.: Ensayo del viernes').fill('   ');
  await expect(save).toBeDisabled();
});

test('in practice: import a JSON export, save as a new setlist, export again', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Practicar sin conexión' }).click();
  await page.getByRole('button', { name: 'Importar' }).click();
  const importDialog = page.getByRole('dialog', { name: 'Importar temas' });
  const json = JSON.stringify({
    app: 'SyncroBeat',
    version: 1,
    name: 'Del archivo',
    songs: [
      { title: 'Vals', bpm: 150, timeSignature: { numerator: 3, denominator: 4 }, subdivision: '1', accentPattern: [2, 1, 1] },
      { title: 'Rock', bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, subdivision: '2', accentPattern: [2, 1, 2, 1] },
    ],
  });
  await importDialog.locator('input[type=file]').setInputFiles({ name: 'lista.json', mimeType: 'application/json', buffer: Buffer.from(json) });
  await expect(importDialog.getByText('Archivo cargado: 2 temas')).toBeVisible();
  await importDialog.getByRole('button', { name: 'Importar (2)' }).click();
  await expect(page.getByText('2 temas importados')).toBeVisible();
  await expect(page.getByText('3/4').first()).toBeVisible();

  // A broken file shows an error instead of failing silently
  await page.getByRole('button', { name: 'Importar' }).click();
  await importDialog.locator('input[type=file]').setInputFiles({ name: 'roto.json', mimeType: 'application/json', buffer: Buffer.from('{oops') });
  await expect(importDialog.getByText(/No se pudo leer el archivo/)).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Guardar en mis setlists' }).click();
  await page.getByLabel('Guardar en mis setlists (en este dispositivo)').fill('Desde JSON');
  await page.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(page.getByText('Guardado como «Desde JSON»')).toBeVisible();
  await expect(page.getByText('los cambios se guardan en tus setlists')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exportar setlist a un archivo' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('Desde JSON.json');
  const exported = JSON.parse(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
  expect(exported.name).toBe('Desde JSON');
  expect(exported.songs.map((s: any) => s.title)).toEqual(['Vals', 'Rock']);
});
