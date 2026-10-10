import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveServerUrls } from '../../src/utils/serverUrls.ts';

test('web keeps the same server; native uses HTTPS/WSS instead of the WebView localhost', () => {
  assert.deepEqual(resolveServerUrls(undefined, undefined, 'http://127.0.0.1:3000'), { api:'http://127.0.0.1:3000', websocket:'ws://127.0.0.1:3000/api/ws', share:'http://127.0.0.1:3000' });
  assert.deepEqual(resolveServerUrls('https://syncrobeat.onrender.com', undefined, 'capacitor://localhost', true), { api:'https://syncrobeat.onrender.com', websocket:'wss://syncrobeat.onrender.com/api/ws', share:'https://syncrobeat.onrender.com' });
});

test('native builds reject missing endpoints, cleartext and room links used as server origins', () => {
  for (const origin of [undefined, 'http://localhost:3000', 'https://syncrobeat.onrender.com/?room=ABC', 'https://user:password@example.com']) {
    assert.throws(() => resolveServerUrls(origin, undefined, 'capacitor://localhost', true));
  }
  assert.throws(() => resolveServerUrls(undefined, 'http://external.example', 'http://localhost:3000'));
  assert.throws(() => resolveServerUrls('https://example.com', 'https://user:secret@example.com', 'capacitor://localhost', true));
});
