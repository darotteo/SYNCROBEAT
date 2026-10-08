import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Loads serverUrl.ts with a given VITE_SERVER_URL and page origin, bypassing the module cache. */
async function load(configured: string | undefined, origin: string) {
  (globalThis as any).window = { location: { origin } };
  const src = await (await import('node:fs/promises')).readFile(new URL('../../src/utils/serverUrl.ts', import.meta.url), 'utf8');
  const js = src.replace('import.meta.env.VITE_SERVER_URL', JSON.stringify(configured ?? ''));
  const { transform } = await import('../../node_modules/tsx/node_modules/esbuild/lib/main.js');
  const out = await transform(js, { loader: 'ts', format: 'esm' });
  return import(`data:text/javascript;base64,${Buffer.from(out.code).toString('base64')}`);
}

beforeEach(() => {
  delete (globalThis as any).window;
});

test('on the web it uses the page origin, so any deployment just works', async () => {
  const m = await load(undefined, 'https://syncrobeat.onrender.com');
  assert.equal(m.serverOrigin(), 'https://syncrobeat.onrender.com');
  assert.equal(m.apiUrl('/api/health'), 'https://syncrobeat.onrender.com/api/health');
  assert.equal(m.roomSocketUrl(), 'wss://syncrobeat.onrender.com/api/ws');
  assert.equal(m.invitationUrl('AB12'), 'https://syncrobeat.onrender.com/?room=AB12');
});

test('plain http uses ws, not wss', async () => {
  const m = await load(undefined, 'http://127.0.0.1:3000');
  assert.equal(m.roomSocketUrl(), 'ws://127.0.0.1:3000/api/ws');
});

test('a packaged app ignores its own localhost origin and uses the configured server', async () => {
  const m = await load('https://syncrobeat.onrender.com', 'capacitor://localhost');
  assert.equal(m.serverOrigin(), 'https://syncrobeat.onrender.com');
  assert.equal(m.roomSocketUrl(), 'wss://syncrobeat.onrender.com/api/ws');
  // The invitation must send people to the server, never to the phone that is inviting
  assert.equal(m.invitationUrl('AB12'), 'https://syncrobeat.onrender.com/?room=AB12');
});

test('a trailing slash or stray spaces in the build setting do not produce a double slash', async () => {
  const m = await load('  https://syncrobeat.onrender.com//  ', 'capacitor://localhost');
  assert.equal(m.apiUrl('/api/health'), 'https://syncrobeat.onrender.com/api/health');
});

test('room codes are escaped in the invitation link', async () => {
  const m = await load(undefined, 'https://x.com');
  assert.equal(m.invitationUrl('A B&C'), 'https://x.com/?room=A%20B%26C');
});
