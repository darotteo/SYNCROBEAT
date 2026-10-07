import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePastedList, parseSetlistJson, clampBpm } from '../../src/utils/setlistParse.ts';

const simple = (text: string, def = 100) => parsePastedList(text, def).map((s) => ({ title: s.title, bpm: s.bpm, notes: s.notes }));

test('paste: WhatsApp / notes formats', () => {
  assert.deepEqual(
    simple(
      [
        '1. Despido Inicial - 95',
        '2) Virus Intro Piano, 95 bpm',
        'Rock 120',
        'Balada (voz sola) 72',
        '[5] *Cumbia* - BPM: 98',
        'tema 6: La Final - tempo 140',
        '07 - Tema sin tempo',
      ].join('\n')
    ),
    [
      { title: 'Despido Inicial', bpm: 95, notes: undefined },
      { title: 'Virus Intro Piano', bpm: 95, notes: undefined },
      { title: 'Rock', bpm: 120, notes: undefined },
      { title: 'Balada', bpm: 72, notes: 'voz sola' },
      { title: 'Cumbia', bpm: 98, notes: undefined },
      { title: 'La Final', bpm: 140, notes: undefined },
      { title: 'Tema sin tempo', bpm: 100, notes: undefined },
    ]
  );
});

test('paste: Windows line endings, blank lines and whitespace are ignored', () => {
  assert.deepEqual(simple('  Uno - 90  \r\n\r\n\tDos 110\r\n   \n'), [
    { title: 'Uno', bpm: 90, notes: undefined },
    { title: 'Dos', bpm: 110, notes: undefined },
  ]);
});

test('paste: out of range numbers are not taken as tempo', () => {
  // 15 and 999 are outside 30â€“300; they stay in the title / default BPM is used
  assert.deepEqual(simple('Tema 999', 88), [{ title: 'Tema 999', bpm: 88, notes: undefined }]);
  assert.deepEqual(simple('Track 15', 88), [{ title: 'Track 15', bpm: 88, notes: undefined }]);
});

test('paste: a song called "Tema N" is not swallowed by the numbering cleanup', () => {
  assert.deepEqual(simple('Tema 5 - 100\n3. Tema 2 - 90'), [
    { title: 'Tema 5', bpm: 100, notes: undefined },
    { title: 'Tema 2', bpm: 90, notes: undefined },
  ]);
});

test('paste: every song gets a unique id, default 4/4 and a valid accent pattern', () => {
  const songs = parsePastedList(Array.from({ length: 50 }, (_, i) => `Canción ${i} - ${60 + i}`).join('\n'), 100);
  assert.equal(songs.length, 50);
  assert.equal(new Set(songs.map((s) => s.id)).size, 50);
  for (const s of songs) {
    assert.deepEqual(s.timeSignature, { numerator: 4, denominator: 4 });
    assert.deepEqual(s.accentPattern, [2, 1, 1, 1]);
    assert.equal(s.subdivision, '1');
  }
});

test('paste: long titles are cut to 80 characters; empty input gives nothing', () => {
  assert.equal(parsePastedList('x'.repeat(200) + ' - 100', 100)[0].title.length, 80);
  assert.deepEqual(parsePastedList('', 100), []);
  assert.deepEqual(parsePastedList('\n\n  \n', 100), []);
});

test('json: round trip of a SyncroBeat export', () => {
  const exported = {
    app: 'SyncroBeat',
    version: 1,
    name: 'Ensayo',
    songs: [
      { title: 'Vals', bpm: 150, timeSignature: { numerator: 3, denominator: 4 }, subdivision: '3', accentPattern: [2, 0, 1], notes: 'suave' },
      { title: 'Rock', bpm: 120, timeSignature: { numerator: 4, denominator: 4 }, subdivision: '2', accentPattern: [2, 1, 2, 1] },
    ],
  };
  const { name, songs } = parseSetlistJson(JSON.stringify(exported));
  assert.equal(name, 'Ensayo');
  assert.equal(songs.length, 2);
  assert.deepEqual(
    songs.map(({ id, ...s }) => s),
    exported.songs
  );
});

test('json: plain array, junk entries and invalid values are cleaned', () => {
  const { name, songs } = parseSetlistJson(
    JSON.stringify([
      null,
      42,
      { bpm: 100 }, // no title
      { title: '  ' },
      { title: 'Rápido', bpm: 9999, timeSignature: { numerator: 11, denominator: 3 }, subdivision: '7', accentPattern: [5, -2] },
      { title: 'Sin bpm' },
    ])
  );
  assert.equal(name, undefined);
  assert.equal(songs.length, 2);
  assert.equal(songs[0].bpm, 300);
  assert.deepEqual(songs[0].timeSignature, { numerator: 4, denominator: 4 });
  assert.equal(songs[0].subdivision, '1');
  assert.deepEqual(songs[0].accentPattern, [2, 1, 1, 1]);
  assert.equal(songs[1].bpm, 120);
});

test('json: accent values are clamped to 0â€“2', () => {
  const { songs } = parseSetlistJson(JSON.stringify([{ title: 'A', bpm: 90, timeSignature: { numerator: 3, denominator: 4 }, accentPattern: [7, -3, 1.4] }]));
  assert.deepEqual(songs[0].accentPattern, [2, 0, 1]);
});

test('json: invalid JSON throws (the UI shows an error)', () => {
  assert.throws(() => parseSetlistJson('{not json'));
});

test('clampBpm', () => {
  assert.equal(clampBpm(10), 30);
  assert.equal(clampBpm(1000), 300);
  assert.equal(clampBpm(99.6), 100);
  assert.equal(clampBpm(NaN), 120);
  assert.equal(clampBpm(0), 120);
});
