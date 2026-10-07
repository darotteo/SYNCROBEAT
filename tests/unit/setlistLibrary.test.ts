import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage that can be told to fail (quota exceeded / private mode)
const store = new Map<string, string>();
let failWrites = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error('QuotaExceededError');
    store.set(k, String(v));
  },
  removeItem: (k: string) => store.delete(k),
};

const lib = await import('../../src/utils/setlistLibrary.ts');
const { getClientId } = await import('../../src/utils/clientId.ts');

const song = (id: string, bpm = 100) => ({
  id,
  title: `Tema ${id}`,
  bpm,
  timeSignature: { numerator: 4, denominator: 4 },
  subdivision: '1' as const,
  accentPattern: [2, 1, 1, 1],
});

beforeEach(() => {
  store.clear();
  failWrites = false;
});

test('empty storage gives an empty library', () => {
  assert.deepEqual(lib.loadSetlistLibrary(), []);
});

test('upsert creates, then replaces by id; delete removes', () => {
  lib.upsertSetlist({ id: 'a', name: 'A', songs: [song('1')] });
  lib.upsertSetlist({ id: 'b', name: 'B', songs: [song('2')] });
  lib.upsertSetlist({ id: 'a', name: 'A2', songs: [song('3')] });
  const all = lib.loadSetlistLibrary();
  assert.deepEqual(all.map((l) => l.name), ['A2', 'B']);
  assert.equal(all[0].songs[0].id, '3');
  assert.deepEqual(lib.deleteSetlist('a')!.map((l) => l.id), ['b']);
  assert.equal(lib.getSetlist('a'), undefined);
  assert.equal(lib.getSetlist('b')!.name, 'B');
});

test('corrupted or invalid stored data never crashes and is filtered', () => {
  store.set('syncbeat_setlist_library', '{broken');
  assert.deepEqual(lib.loadSetlistLibrary(), []);
  store.set('syncbeat_setlist_library', JSON.stringify([{ id: 'ok', name: 'Ok', songs: [] }, { id: 1 }, null, 'x']));
  assert.deepEqual(lib.loadSetlistLibrary().map((l) => l.id), ['ok']);
});

test('the old single "Mi lista" is migrated exactly once', () => {
  store.set('syncbeat_custom_local_setlist', JSON.stringify([song('old')]));
  const first = lib.loadSetlistLibrary();
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'Mi setlist');
  // User deletes it: it must not come back
  lib.deleteSetlist('my-list');
  assert.deepEqual(lib.loadSetlistLibrary(), []);
});

test('failed writes are reported instead of throwing', () => {
  failWrites = true;
  assert.equal(lib.upsertSetlist({ id: 'a', name: 'A', songs: [song('1')] }), null);
  assert.equal(lib.saveSetlistLibrary([]), false);
  assert.doesNotThrow(() => lib.saveLastSelectedSetlistId('x'));
});

test('syncSavedSetlist only updates setlists this device has, and never empties them', () => {
  lib.upsertSetlist({ id: 'a', name: 'A', songs: [song('1')] });
  lib.syncSavedSetlist('a', null, [song('1', 130)]);
  assert.equal(lib.getSetlist('a')!.songs[0].bpm, 130);
  assert.equal(lib.getSetlist('a')!.name, 'A', 'keeps the saved name when the room has none');
  lib.syncSavedSetlist('a', 'Nuevo', [song('2')]);
  assert.equal(lib.getSetlist('a')!.name, 'Nuevo');
  lib.syncSavedSetlist('a', 'Nuevo', []);
  assert.equal(lib.getSetlist('a')!.songs.length, 1, 'clearing the room must not wipe the saved setlist');
  lib.syncSavedSetlist('zzz', 'Ajena', [song('9')]);
  assert.equal(lib.getSetlist('zzz'), undefined, 'a list from another device is not created silently');
  lib.syncSavedSetlist(null, 'x', [song('9')]);
  assert.equal(lib.loadSetlistLibrary().length, 1);
});

test('last selected setlist id is remembered and cleared', () => {
  assert.equal(lib.loadLastSelectedSetlistId(), '');
  lib.saveLastSelectedSetlistId('abc');
  assert.equal(lib.loadLastSelectedSetlistId(), 'abc');
  lib.saveLastSelectedSetlistId('');
  assert.equal(lib.loadLastSelectedSetlistId(), '');
});

test('new setlist ids are unique', () => {
  const ids = new Set(Array.from({ length: 1000 }, () => lib.newSetlistId()));
  assert.equal(ids.size, 1000);
});

test('client id is stable, valid for the server, and replaced if tampered with', () => {
  const id = getClientId();
  assert.match(id, /^[A-Za-z0-9-]{8,64}$/);
  assert.equal(getClientId(), id);
  store.set('syncbeat_client_id', 'bad id!');
  const fixed = getClientId();
  assert.match(fixed, /^[A-Za-z0-9-]{8,64}$/);
  assert.equal(store.get('syncbeat_client_id'), fixed);
});
