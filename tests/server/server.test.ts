/** Protocol tests against the real server process (WebSocket + HTTP). */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, join, newRoom, Client, RunningServer } from '../helpers/server.ts';

let srv: RunningServer;
const open: Client[] = [];
const track = <T extends { c: Client }>(x: T) => (open.push(x.c), x);

before(async () => {
  srv = await startServer();
});
after(async () => {
  open.forEach((c) => c.close());
  await srv.stop();
});

const song = (id: string, bpm: number, num = 4) => ({
  id,
  title: `Tema ${id}`,
  bpm,
  timeSignature: { numerator: num, denominator: 4 },
  subdivision: '1',
  accentPattern: Array.from({ length: num }, (_, i) => (i === 0 ? 2 : 1)),
});
const isPlayback = (m: any) => m.type === 'playback_state';
const isState = (m: any) => m.type === 'room_state';
const isError = (m: any) => m.type === 'error';

test('HTTP: health, SPA fallback, room metadata', async () => {
  const health = await fetch(`${srv.url}/api/health`).then((r) => r.json());
  assert.equal(health.status, 'ok');
  assert.ok(Math.abs(health.serverTime - Date.now()) < 5000);

  const page = await fetch(`${srv.url}/some/deep/link?room=ABC`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root">/);
  assert.match(page.headers.get('cache-control') || '', /no-cache/);

  const missing = await fetch(`${srv.url}/api/rooms/NOPE-${Date.now()}`).then((r) => r.json());
  assert.deepEqual(missing, { exists: false, membersCount: 0, drumsTaken: false });
});

test('ping/pong echoes clientTime and returns server time', async () => {
  const c = await Client.connect(srv.wsUrl);
  open.push(c);
  const t0 = Date.now();
  const pong = await c.request({ type: 'ping', clientTime: 12345.5 }, (m) => m.type === 'pong');
  assert.equal(pong.clientTime, 12345.5);
  assert.ok(pong.serverTime >= t0 - 1000 && pong.serverTime <= Date.now() + 1000);
});

test('join: invalid room code is rejected; garbage input never crashes the server', async () => {
  const c = await Client.connect(srv.wsUrl);
  open.push(c);
  const err = await c.request({ type: 'join', roomId: '!!!', clientId: 'garbage-01', instrument: 'drums' }, isError);
  assert.match(err.message, /inválido/);
  c.ws.send('not json');
  c.ws.send(JSON.stringify(null));
  c.ws.send(JSON.stringify({ type: 42 }));
  c.ws.send(JSON.stringify({ type: 'play' })); // not in a room
  c.ws.send(JSON.stringify({ type: 'unknown-type' }));
  const pong = await c.request({ type: 'ping', clientTime: 1 }, (m) => m.type === 'pong');
  assert.ok(pong, 'server still answering');
});

test('roles: only the host controls playback, tempo, meter, setlist and songs', async () => {
  const room = newRoom();
  const drummer = track(await join(srv.wsUrl, room, 'roles-drum-1', 'drums', { initialSetlist: { id: 'l1', name: 'Lista', songs: [song('a', 100), song('b', 140)] } }));
  const guitar = track(await join(srv.wsUrl, room, 'roles-gtr-1', 'guitar'));
  for (const msg of [
    { type: 'play' },
    { type: 'stop' },
    { type: 'setBpm', bpm: 90 },
    { type: 'setTimeSignature', timeSignature: { numerator: 3, denominator: 4 } },
    { type: 'setSubdivision', subdivision: '2' },
    { type: 'setAccentPattern', accentPattern: [0, 0, 0, 0] },
    { type: 'setCountInBars', countInBars: 2 },
    { type: 'updateSetlist', setlist: [] },
    { type: 'selectSong', songId: 'b' },
  ]) {
    const err = await guitar.c.request(msg, isError);
    assert.match(err.message, /dirige la sala/i, `${msg.type} must be refused`);
  }
  assert.ok(await drummer.c.expectNothing(isPlayback, 200), 'refused actions are not broadcast');
  const meta = await fetch(`${srv.url}/api/rooms/${room}`).then((r) => r.json());
  assert.equal(meta.bpm, 100);
  assert.equal(meta.isPlaying, false);
  assert.equal(meta.setlistCount, 2);
});

test('the host can hand the room to a musician who is not the drummer', async () => {
  const room = newRoom();
  const drummer = track(await join(srv.wsUrl, room, 'host-drum-1', 'drums'));
  const guitar = track(await join(srv.wsUrl, room, 'host-gtr-1', 'guitar'));
  // The first to arrive runs the room
  assert.equal(drummer.state.leaderId, 'host-drum-1');

  // Nobody else can take it
  const stolen = await guitar.c.request({ type: 'setHost', memberId: 'host-gtr-1' }, isError);
  assert.match(stolen.message, /dirige la sala/i);

  const handed = await drummer.c.request(
    { type: 'setHost', memberId: 'host-gtr-1' },
    (m) => m.type === 'members_update'
  );
  assert.deepEqual(
    handed.members.filter((m: any) => m.isLeader).map((m: any) => m.id),
    ['host-gtr-1'],
    'exactly one member leads the room'
  );

  // The guitarist now drives it, and the drummer no longer does
  await guitar.c.request({ type: 'setBpm', bpm: 96 }, isPlayback);
  const refused = await drummer.c.request({ type: 'setBpm', bpm: 140 }, isError);
  assert.match(refused.message, /dirige la sala/i);
  const meta = await fetch(`${srv.url}/api/rooms/${room}`).then((r) => r.json());
  assert.equal(meta.bpm, 96);
});

test('a room holds three musicians; the fourth is told what is coming, and a rejoin is not a fourth', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'cap-drum', 'drums'));
  track(await join(srv.wsUrl, room, 'cap-guitar', 'guitar'));
  track(await join(srv.wsUrl, room, 'cap-bass', 'bass'));

  const fourth = await join(srv.wsUrl, room, 'cap-keys', 'keys');
  track(fourth);
  assert.equal(fourth.msg.code, 'room_full');
  assert.match(fourth.msg.message, /hasta 3/i);
  // The refusal must not cost the trio anything
  assert.equal((await fetch(`${srv.url}/api/rooms/${room}`).then((r) => r.json())).membersCount, 3);

  // A phone waking up rejoins its own rehearsal: its seat is already taken by itself
  const back = track(await join(srv.wsUrl, room, 'cap-guitar', 'guitar'));
  assert.ok(back.state, 'a reconnecting member is let back in');
  assert.equal(back.state.members.length, 3, 'and does not take a second seat');
  assert.ok(await d.c.expectNothing(isError, 200));
});

test('only one drummer per room; the same device can reclaim its seat', async () => {
  const room = newRoom();
  const d1 = track(await join(srv.wsUrl, room, 'seat-drum-1', 'drums'));
  const meta = await fetch(`${srv.url}/api/rooms/${room}?clientId=someone-else`).then((r) => r.json());
  assert.equal(meta.drumsTaken, true);
  const own = await fetch(`${srv.url}/api/rooms/${room}?clientId=seat-drum-1`).then((r) => r.json());
  assert.equal(own.drumsTaken, false, 'a drummer reloading the page can rejoin');

  const d2 = track(await join(srv.wsUrl, room, 'seat-drum-2', 'drums'));
  assert.equal(d2.msg.type, 'error');
  assert.equal(d2.msg.code, 'drums_taken');

  // Switching to drums from inside the room is also blocked
  const g = track(await join(srv.wsUrl, room, 'seat-gtr-1', 'guitar'));
  const err = await g.c.request({ type: 'updateMember', instrument: 'drums' }, isError);
  assert.equal(err.code, 'drums_taken');

  // Same device reconnecting (phone woke up): old socket retired, one member, still drummer
  const again = track(await join(srv.wsUrl, room, 'seat-drum-1', 'drums'));
  assert.equal(again.msg.type, 'room_state');
  assert.equal(again.state.members.filter((m: any) => m.id === 'seat-drum-1').length, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(d1.c.ws.readyState, d1.c.ws.CLOSED, 'stale socket closed');
  // The retired socket closing must not remove the reclaimed seat
  const after = await fetch(`${srv.url}/api/rooms/${room}`).then((r) => r.json());
  assert.equal(after.membersCount, 2);
});

test('play: every client gets the same future start time; stop clears it', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'play-drum-1', 'drums'));
  const g = track(await join(srv.wsUrl, room, 'play-gtr-1', 'guitar'));
  const k = track(await join(srv.wsUrl, room, 'play-keys-1', 'keys'));
  d.c.send({ type: 'setCountInBars', countInBars: 2 });
  await g.c.waitFor((m) => isState(m) && m.state.countInBars === 2);
  const t0 = Date.now();
  const [pd, pg, pk] = await Promise.all([
    d.c.request({ type: 'play' }, isPlayback),
    g.c.waitFor(isPlayback, { since: g.c.messages.length }),
    k.c.waitFor(isPlayback, { since: k.c.messages.length }),
  ]);
  assert.equal(pd.isPlaying, true);
  assert.equal(pd.startServerTime, pg.startServerTime);
  assert.equal(pd.startServerTime, pk.startServerTime);
  assert.ok(pd.startServerTime >= t0 + 200, 'start leaves time for every client to receive it');
  assert.equal(pd.countInBeats, 8, '2 bars of 4/4 count-in');
  const stop = await d.c.request({ type: 'stop' }, (m) => isPlayback(m) && !m.isPlaying);
  assert.equal(stop.startServerTime, null);
});

test('tempo change while playing lands on a future bar line of the old tempo', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'bar-drum-1', 'drums'));
  const play = await d.c.request({ type: 'play' }, isPlayback);
  await new Promise((r) => setTimeout(r, 700));
  const sentAt = Date.now();
  const change = await d.c.request({ type: 'setBpm', bpm: 150 }, isPlayback);
  assert.equal(change.bpm, 150);
  assert.equal(change.countInBeats, 0, 'no count-in on a tempo change');
  const barMs = (60_000 / 120) * 4;
  const bars = (change.startServerTime - play.startServerTime) / barMs;
  assert.ok(Math.abs(bars - Math.round(bars)) < 1e-6, 'new anchor is on a bar line');
  assert.ok(change.startServerTime >= sentAt + 300, 'at least ~350 ms notice');

  // Changing tempo before the first beat keeps the original anchor
  await d.c.request({ type: 'stop' }, isPlayback);
  const p2 = await d.c.request({ type: 'play' }, isPlayback);
  const early = await d.c.request({ type: 'setBpm', bpm: 90 }, isPlayback);
  assert.equal(early.startServerTime, p2.startServerTime);
});

test('values are sanitized: bpm clamped, bad meters ignored, accents fitted to the meter', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'san-drum-1', 'drums'));
  assert.equal((await d.c.request({ type: 'setBpm', bpm: 9999 }, isPlayback)).bpm, 300);
  assert.equal((await d.c.request({ type: 'setBpm', bpm: -5 }, isPlayback)).bpm, 30);
  const since = d.c.messages.length;
  d.c.send({ type: 'setBpm', bpm: 'abc' });
  d.c.send({ type: 'setTimeSignature', timeSignature: { numerator: 4, denominator: 5 } });
  d.c.send({ type: 'setSubdivision', subdivision: '9' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(d.c.messages.slice(since).filter(isPlayback).length, 0, 'invalid values produce no change');
  const ts = await d.c.request({ type: 'setTimeSignature', timeSignature: { numerator: 7, denominator: 8 }, accentPattern: [2, 1] }, isPlayback);
  assert.deepEqual(ts.timeSignature, { numerator: 7, denominator: 8 });
  assert.deepEqual(ts.accentPattern, [2, 1, 1, 1, 1, 1, 1], 'wrong-length pattern replaced by default');
  const acc = await d.c.request({ type: 'setAccentPattern', accentPattern: [5, -1, 1, 0, 2, 1, 'x'] }, isPlayback);
  assert.deepEqual(acc.accentPattern, [2, 0, 1, 0, 2, 1, 1]);
  const cnt = await d.c.request({ type: 'setCountInBars', countInBars: 9 }, isState);
  assert.equal(cnt.state.countInBars, 2);
});

test('setlist: sanitized on the server (limits, duplicates, junk)', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'list-drum-1', 'drums'));
  const many = Array.from({ length: 200 }, (_, i) => song(`s${i}`, 100));
  const res = await d.c.request(
    {
      type: 'updateSetlist',
      setlist: [
        { title: '', bpm: 100 },
        null,
        { id: 'dup', title: 'A\u0000\u0007 <b>x</b>' + 'y'.repeat(200), bpm: 9999, timeSignature: { numerator: 99, denominator: 3 }, accentPattern: [1] },
        { id: 'dup', title: 'B', bpm: 80 },
        ...many,
      ],
      setlistId: 'lib-1',
      setlistName: 'Viernes',
    },
    isState
  );
  const list = res.state.setlist;
  assert.equal(list.length, 150, 'capped at MAX_SETLIST_SONGS');
  assert.equal(list[0].title.length, 80);
  assert.doesNotMatch(list[0].title, /[\u0000-\u001f]/);
  assert.equal(list[0].bpm, 300);
  assert.deepEqual(list[0].timeSignature, { numerator: 4, denominator: 4 });
  assert.deepEqual(list[0].accentPattern, [2, 1, 1, 1]);
  assert.notEqual(list[0].id, list[1].id, 'duplicate ids are made unique');
  assert.equal(res.state.setlistName, 'Viernes');
  assert.equal(res.state.currentSongId, list[0].id, 'stopped room selects the first song');
  assert.equal(res.state.bpm, 300);

  // A plain edit (no meta) keeps the name; emptying the list clears it
  const edit = await d.c.request({ type: 'updateSetlist', setlist: [song('x', 77)] }, isState);
  assert.equal(edit.state.setlistName, 'Viernes');
  assert.equal(edit.state.bpm, 77, 'previous song vanished → first song applied');
  const empty = await d.c.request({ type: 'updateSetlist', setlist: [] }, isState);
  assert.equal(empty.state.setlistName, null);
  assert.equal(empty.state.setlistId, null);
  assert.equal(empty.state.currentSongId, null);
});

test('selectSong applies the song settings and announces it to everybody', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'sel-drum-1', 'drums', { initialSetlist: { id: 'l', name: 'L', songs: [song('a', 100), song('b', 160, 3)] } }));
  const g = track(await join(srv.wsUrl, room, 'sel-gtr-1', 'guitar'));
  const since = g.c.messages.length;
  d.c.send({ type: 'selectSong', songId: 'b' });
  const sel = await g.c.waitFor((m) => m.type === 'song_selected', { since });
  assert.equal(sel.song.id, 'b');
  const pb = await g.c.waitFor(isPlayback, { since });
  assert.equal(pb.bpm, 160);
  assert.deepEqual(pb.timeSignature, { numerator: 3, denominator: 4 });
  await d.c.waitFor((m) => isPlayback(m) && m.bpm === 160); // over a real network it can arrive late
  const err = d.c.request({ type: 'selectSong', songId: 'does-not-exist' }, isPlayback, 300);
  await assert.rejects(err, /Timed out/, 'unknown song ignored');
});

test('prepared setlist: host only, empty stopped room only, rejoin preserves, legacy array accepted', async () => {
  const room = newRoom();
  const prepared = { id: 'check-list', name: 'Prueba', songs: [song('test-song', 93, 3)] };
  // Whoever opens the room seeds it, drummer or not
  const gtr = track(await join(srv.wsUrl, room, 'prep-gtr-1', 'guitar', { initialSetlist: prepared }));
  assert.equal(gtr.state.currentSongId, 'test-song');
  assert.equal(gtr.state.setlistName, 'Prueba');
  assert.equal(gtr.state.setlistId, 'check-list');
  assert.equal(gtr.state.bpm, 93);
  const drum = track(await join(srv.wsUrl, room, 'prep-drum-1', 'drums', { initialSetlist: { id: 'y', name: 'Suya', songs: [song('intruder', 150)] } }));
  assert.equal(drum.state.setlist[0].id, 'test-song', 'a later arrival may not replace the room list');
  assert.equal(drum.state.setlist.length, 1);
  const re = track(await join(srv.wsUrl, room, 'prep-gtr-1', 'guitar', { initialSetlist: { id: 'x', name: 'Otra', songs: [song('replacement', 150)] } }));
  assert.equal(re.state.setlist[0].id, 'test-song', 'a rejoin must preserve the existing room list');

  // Playing room with empty list: a joining drummer may not inject a list
  const room2 = newRoom();
  const d2 = track(await join(srv.wsUrl, room2, 'prep-drum-2', 'drums'));
  await d2.c.request({ type: 'play' }, isPlayback);
  await d2.c.request({ type: 'updateMember', instrument: 'guitar' }, (m) => m.type === 'members_update');
  const d3 = track(await join(srv.wsUrl, room2, 'prep-drum-3', 'drums', { initialSetlist: prepared }));
  assert.equal(d3.state.setlist.length, 0, 'active playback takes precedence');

  const legacy = track(await join(srv.wsUrl, newRoom(), 'prep-legacy-1', 'drums', { initialSetlist: [song('old', 111)] }));
  assert.equal(legacy.state.setlist[0].id, 'old', 'legacy array setlist is still accepted');
  assert.equal(legacy.state.setlistName, null);
});

test('members: profile updates broadcast; leaving hands leadership over; empty room stops', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'mem-drum-1', 'drums'));
  const g = track(await join(srv.wsUrl, room, 'mem-gtr-1', 'guitar'));
  assert.equal(d.state.leaderId, 'mem-drum-1');
  const upd = await d.c.request({ type: 'updateMember', name: '  Ana\u0000  la   baterista  ' + 'x'.repeat(50) }, (m) => m.type === 'members_update' && m.members.some((x: any) => x.name.startsWith('Ana')));
  const me = upd.members.find((m: any) => m.id === 'mem-drum-1');
  assert.equal(me.name.length, 25);
  assert.match(me.name, /^Ana la baterista/);

  await d.c.request({ type: 'play' }, isPlayback);
  const since = g.c.messages.length;
  d.c.close();
  const mu = await g.c.waitFor((m) => m.type === 'members_update', { since });
  assert.equal(mu.members.length, 1);
  assert.equal(mu.members[0].isLeader, true, 'leadership passes to the remaining member');

  g.c.close();
  await new Promise((r) => setTimeout(r, 150));
  const meta = await fetch(`${srv.url}/api/rooms/${room}`).then((r) => r.json());
  assert.equal(meta.membersCount, 0);
  assert.equal(meta.isPlaying, false, 'an empty room stops playing');
});

test('playing room: a late joiner receives the running anchor to join in phase', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'late-drum-1', 'drums'));
  const pb = await d.c.request({ type: 'play' }, isPlayback);
  await new Promise((r) => setTimeout(r, 300));
  const late = track(await join(srv.wsUrl, room, 'late-gtr-1', 'guitar'));
  assert.equal(late.state.isPlaying, true);
  assert.equal(late.state.startServerTime, pb.startServerTime);
  assert.equal(late.state.bpm, pb.bpm);
});

test('cues: text sanitized, broadcast to everyone, history capped at 20', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'cue-drum-1', 'drums'));
  const g = track(await join(srv.wsUrl, room, 'cue-gtr-1', 'guitar'));
  const since = d.c.messages.length;
  g.c.send({ type: 'sendCue', text: '  ¡Coro!\n\n ' + 'z'.repeat(300), cueType: 'evil' });
  const cue = await d.c.waitFor((m) => m.type === 'cue_broadcast', { since });
  assert.equal(cue.cue.senderName, 'cue-gtr-1');
  assert.equal(cue.cue.type, 'custom');
  assert.equal(cue.cue.text.length, 120);
  assert.match(cue.cue.text, /^¡Coro! z/);
  assert.ok(await d.c.expectNothing((m) => m.type === 'cue_broadcast' && m.cue.text === '', 100));
  g.c.send({ type: 'sendCue', text: '   ', cueType: 'section' });
  for (let i = 0; i < 25; i++) g.c.send({ type: 'sendCue', text: `cue ${i}`, cueType: 'section' });
  await d.c.waitFor((m) => m.type === 'cue_broadcast' && m.cue.text === 'cue 24');
  const again = track(await join(srv.wsUrl, room, 'cue-keys-1', 'keys'));
  assert.equal(again.state.recentCues.length, 20);
  assert.equal(again.state.recentCues[0].text, 'cue 24');
});

test('rate limit: a flood is cut with one warning, and the client recovers', async () => {
  const room = newRoom();
  const d = track(await join(srv.wsUrl, room, 'rate-drum-1', 'drums'));
  const since = d.c.messages.length;
  for (let i = 0; i < 200; i++) d.c.send({ type: 'ping', clientTime: i });
  await new Promise((r) => setTimeout(r, 300));
  const after = d.c.messages.slice(since);
  const pongs = after.filter((m) => m.type === 'pong').length;
  const warnings = after.filter((m) => m.code === 'rate_limited').length;
  assert.ok(pongs >= 30 && pongs < 100, `pongs: ${pongs}`);
  assert.equal(warnings, 1);
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(await d.c.request({ type: 'ping', clientTime: 1 }, (m) => m.type === 'pong'));
});

test('oversized messages close the socket instead of being processed', async () => {
  const c = await Client.connect(srv.wsUrl);
  open.push(c);
  const closed = new Promise((r) => c.ws.once('close', r));
  c.ws.send('x'.repeat(300 * 1024));
  await closed;
  const ok = await Client.connect(srv.wsUrl);
  open.push(ok);
  assert.ok(await ok.request({ type: 'ping', clientTime: 1 }, (m) => m.type === 'pong'), 'server still up');
});

test('clock estimate: NTP-style offset from the best pings is within a few ms locally', async () => {
  const c = await Client.connect(srv.wsUrl);
  open.push(c);
  const samples: { offset: number; rtt: number }[] = [];
  for (let i = 0; i < 10; i++) {
    const sent = performance.timeOrigin + performance.now();
    const pong = await c.request({ type: 'ping', clientTime: sent }, (m) => m.type === 'pong');
    const recv = performance.timeOrigin + performance.now();
    samples.push({ offset: pong.serverTime + (recv - sent) / 2 - recv, rtt: recv - sent });
  }
  const best = samples.sort((a, b) => a.rtt - b.rtt).slice(0, 4);
  const offset = best.reduce((s, x) => s + x.offset, 0) / best.length;
  assert.ok(Math.abs(offset) < 15, `same machine must estimate ~0 ms offset, got ${offset.toFixed(1)}`);
});
