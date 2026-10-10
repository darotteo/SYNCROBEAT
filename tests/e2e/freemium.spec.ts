import { test, expect } from '@playwright/test';
import { joinRoom, newRoomCode } from './helpers';

test('free room refuses the third person and the drummer can return by reloading', async ({ browser, contextOptions }) => {
  const contexts = await Promise.all([0,1,2].map(() => browser.newContext(contextOptions)));
  try {
    const [drummer, guitar, bass] = await Promise.all(contexts.map(c=>c.newPage()));
    const room = newRoomCode();
    await joinRoom(drummer,{room,name:'Ana',instrument:'Batería'});
    await joinRoom(guitar,{room,name:'Beto',instrument:'Guitarra'});
    await bass.goto(`/?room=${room}`);
    await bass.getByLabel('Tu nombre').fill('Caro');
    await bass.getByRole('button',{name:/Bajo/}).click();
    await bass.getByRole('button',{name:'Entrar',exact:true}).click();
    await expect(bass.getByText(/límite gratuito de 2 integrantes/)).toBeVisible();
    await expect(drummer.getByRole('button',{name:/Banda · 2/})).toBeVisible();
    await drummer.reload();
    await drummer.getByRole('button',{name:'Entrar',exact:true}).click();
    await expect(drummer.getByRole('button',{name:'Iniciar',exact:true})).toBeVisible();
    await expect(drummer.getByRole('button',{name:/Banda · 2/})).toBeVisible();
  } finally { await Promise.all(contexts.map(c=>c.close())); }
});
