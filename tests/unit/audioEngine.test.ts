/**
 * Runs the real scheduler with independent wall / audio clocks and controllable interruptions.
 * This does not emulate Safari's hardware or audible output: the browser suite (tests/e2e) and a
 * real phone are still needed for that.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const epoch = 1_700_000_000_000;
let wallMs = 0;
let timerId = 0;
const timers = new Map<number, { callback: () => void; delay: number }>();
Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: epoch, now: () => wallMs }, configurable: true });
(globalThis as any).localStorage = { getItem: () => null, setItem() {} };
(globalThis as any).document = { visibilityState: 'visible', addEventListener() {} };

class FakeContext {
  state = 'running';
  currentTime = 10;
  baseLatency = 0;
  outputLatency = 0;
  sampleRate = 48_000;
  onstatechange: null | (() => void) = null;
  resumeCalls = 0;
  suspendCalls = 0;
  getOutputTimestamp?: () => { contextTime: number; performanceTime: number };
  suspend() { this.suspendCalls++; this.transition('suspended'); return Promise.resolve(); }
  resume(): Promise<void> { this.resumeCalls++; this.state = 'running'; this.onstatechange?.(); return Promise.resolve(); }
  transition(state: string) { this.state = state; this.onstatechange?.(); }
}
(globalThis as any).window = {
  AudioContext: FakeContext,
  addEventListener() {},
  setInterval() { return ++timerId; },
  clearInterval() {},
  setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
  clearTimeout(id: number) { timers.delete(id); },
};

const { audioEngine } = await import('../../src/utils/audioEngine.ts');
const Engine = (audioEngine as any).constructor;

interface Click { time: number; key?: string; accent: number; subdivision: boolean; preset?: string; canceled: boolean }

function fixture() {
  wallMs = 0;
  timers.clear();
  const engine = new Engine();
  engine.initMasterChain = () => {};
  engine.startWebAudioKeepAlive = () => {};
  const clicks: Click[] = [];
  engine.playSynthesizedClick = (time: number, accent: number, subdivision: boolean, key?: string, preset?: string) => {
    const click: Click = { time, key, accent, subdivision, preset, canceled: false };
    clicks.push(click);
    if (key) engine.pendingVoices.push({ time, key, cancel: () => { click.canceled = true; } });
  };
  const ctx: FakeContext = engine.getAudioContext();
  const playback = {
    isPlaying: true,
    startServerTime: epoch + 200,
    countInBeats: 0,
    bpm: 120,
    timeSignature: { numerator: 4, denominator: 4 },
    subdivision: '1' as const,
    accentPattern: [2, 1, 1, 1],
  };
  return { engine, ctx, clicks, playback };
}

/** Advances both clocks together (audio clock optionally at a different rate) and ticks the scheduler. */
function run(engine: any, ctx: FakeContext, untilMs: number, stepMs = 25, audioRate = 1) {
  const audioStart = ctx.currentTime - (wallMs / 1000) * audioRate;
  while (wallMs < untilMs) {
    wallMs += stepMs;
    ctx.currentTime = audioStart + (wallMs / 1000) * audioRate;
    engine.scheduler();
  }
}

const active = (clicks: Click[]) => clicks.filter((c) => !c.canceled);

test('interruption discards queued clicks; return joins the shared phase', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  const queued = clicks.slice();
  assert.ok(queued.length >= 3);
  ctx.transition('interrupted');
  assert.ok(queued.every((c) => c.canceled), 'Old queued clicks survived the interruption');
  wallMs = 6250; // Hardware audio clock froze while the room continued.
  engine.scheduler();
  assert.equal(clicks.length, queued.length, 'Suspended audio must not schedule timer-based clicks');
  ctx.transition('running');
  const returned = active(clicks.slice(queued.length));
  assert.ok(returned.length >= 3);
  assert.ok(Math.abs(returned[0].time - 10.45) < 0.005, 'Return must play the next shared beat, not an old beat');
  for (let i = 1; i < returned.length; i++) assert.ok(Math.abs(returned[i].time - returned[i - 1].time - 0.5) < 0.005);
  engine.stop();
});

test('iOS interrupted state can be resumed from a user gesture', () => {
  const { engine, ctx } = fixture();
  ctx.transition('interrupted');
  engine.unlockAudio();
  assert.equal(ctx.state, 'running');
  assert.equal(ctx.resumeCalls, 1);
});

test('a frozen running clock requests recovery and rejoins the shared phase', async () => {
  const { engine, ctx, clicks, playback } = fixture();
  const states: string[] = [];
  engine.onStateChange((state: string) => states.push(state));
  engine.setPlayback(playback);
  const queued = clicks.slice();
  wallMs = 1000;
  engine.scheduler();
  assert.equal(engine.isContextRunning(), false);
  assert.equal(states.at(-1), 'suspended');
  assert.ok(queued.every((c) => c.canceled));
  engine.unlockAudio();
  await engine.resumePromise;
  assert.equal(ctx.suspendCalls, 1);
  assert.equal(ctx.resumeCalls, 1);
  assert.equal(engine.isContextRunning(), true);
  const returned = active(clicks.slice(queued.length));
  assert.ok(Math.abs(returned[0].time - 10.2) < 0.005);
  engine.stop();
});

test('first server clock calibration replaces wrongly queued audio', () => {
  const { engine, clicks, playback } = fixture();
  engine.setPlayback(playback);
  const queued = clicks.slice();
  engine.setServerTimeOffset(1200);
  assert.ok(queued.every((c) => c.canceled), 'Clock calibration kept old queue');
  const corrected = active(clicks.slice(queued.length));
  assert.ok(corrected.length >= 3);
  assert.ok(Math.abs(corrected[0].time - 10.5) < 0.005);
  engine.stop();
});

test('stale output timestamps do not change the audible beat phase', () => {
  const { engine, ctx } = fixture();
  wallMs = 10_000;
  ctx.currentTime = 20;
  ctx.outputLatency = 0.02;
  ctx.getOutputTimestamp = () => ({ contextTime: 10.6, performanceTime: 1000 });
  engine.updateAudioClockOffset(ctx);
  assert.ok(Math.abs(engine.serverToAudioTime(epoch + wallMs + 500) - 20.48) < 0.005);
  assert.equal(engine.getDetectedLatencyMs(), 20);
});

test('valid output timestamps determine playback time without double compensation', () => {
  const { engine, ctx } = fixture();
  wallMs = 10_000;
  ctx.currentTime = 20;
  ctx.baseLatency = 0.01;
  ctx.outputLatency = 0.08;
  ctx.getOutputTimestamp = () => ({ contextTime: 19.98, performanceTime: 9995 });
  engine.updateAudioClockOffset(ctx);
  assert.ok(Math.abs(engine.serverToAudioTime(epoch + wallMs + 500) - 20.485) < 0.005);
});

test('a scheduler stall skips missed clicks without changing phase', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  const oldCount = clicks.length;
  wallMs = 2210;
  ctx.currentTime = 12.21;
  engine.scheduler();
  const resumed = active(clicks.slice(oldCount));
  assert.ok(resumed.length > 0);
  assert.ok(Math.abs(resumed[0].time - 12.7) < 0.005, 'Missed beat must not be clamped to an immediate click');
  engine.stop();
});

test('tempo change keeps the old pulse until the scheduled bar', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  engine.setPlayback({ ...playback, startServerTime: epoch + 2200, bpm: 90 });
  run(engine, ctx, 4000);
  const list = active(clicks);
  const expected = [10.2, 10.7, 11.2, 11.7, 12.2, 12.2 + 60 / 90];
  expected.forEach((time, i) => assert.ok(Math.abs(list[i].time - time) < 0.005));
  assert.equal(new Set(list.map((c) => c.key)).size, list.length);
  engine.stop();
});

test('irregular scheduler ticks keep fixed BPM intervals for ten minutes', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback({ ...playback, bpm: 137 });
  for (let i = 1; wallMs < 600_000; i++) {
    wallMs += [25, 28, 82, 160, 35][i % 5];
    ctx.currentTime = 10 + wallMs / 1000;
    engine.scheduler();
  }
  const list = active(clicks);
  for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i].time - list[i - 1].time - 60 / 137) < 0.001);
  assert.equal(new Set(list.map((c) => c.key)).size, list.length, 'No duplicate beat');
  engine.stop();
});

test('a refused resume (touchstart) does not block the next tap from starting audio', () => {
  const { engine, ctx } = fixture();
  ctx.state = 'suspended';
  const calls: number[] = [];
  ctx.resume = () => {
    calls.push(calls.length);
    if (calls.length === 1) return new Promise(() => {});
    ctx.state = 'running';
    ctx.onstatechange?.();
    return Promise.resolve();
  };
  engine.unlockAudio(); // touchstart: refused, stays pending
  engine.unlockAudio(); // touchend / click: allowed
  assert.equal(calls.length, 2, 'The second tap must call resume() again');
  assert.equal(ctx.state, 'running');
});

test('visual beats keep following the room while audio is blocked', () => {
  const { engine, ctx, clicks, playback } = fixture();
  ctx.state = 'suspended';
  ctx.resume = () => Promise.resolve();
  engine.setPlayback(playback);
  wallMs = 100;
  engine.scheduler();
  assert.equal(clicks.length, 0, 'No audio may be scheduled while blocked');
  const visual = [...timers.values()].find((t) => Math.abs(t.delay - 100) < 1);
  assert.ok(visual, 'The first beat must still be shown on screen, otherwise the UI stays in "Arrancando"');
  engine.stop();
});

test('alternating fresh and stale output timestamps do not move the beat', () => {
  const { engine, ctx } = fixture();
  let cancels = 0;
  const cancel = engine.cancelFutureVoices.bind(engine);
  engine.cancelFutureVoices = (...args: unknown[]) => {
    cancels++;
    return cancel(...args);
  };
  wallMs = 10_000;
  ctx.currentTime = 20;
  ctx.outputLatency = 0; // Safari does not report it; real latency is 150 ms (e.g. Bluetooth)
  const expected = 19.845 - (epoch + 9995) / 1000;
  for (let k = 0; k < 120; k++) {
    const fresh = k % 2 === 0;
    const now = wallMs;
    const audio = ctx.currentTime;
    ctx.getOutputTimestamp = () =>
      fresh ? { contextTime: audio - 0.155, performanceTime: now - 5 } : { contextTime: 1, performanceTime: 1 };
    engine.updateAudioClockOffset(ctx);
    wallMs += 25;
    ctx.currentTime += 0.025;
  }
  assert.ok(Math.abs(engine.audioClockOffset - expected) < 0.003, `offset drifted to ${engine.audioClockOffset - expected}`);
  assert.ok(cancels <= 1, `queued clicks were rebuilt ${cancels} times`);
  assert.equal(engine.getDiagnostics().clockSource, 'output');
});

// ---------------------------------------------------------------------------
// New coverage
// ---------------------------------------------------------------------------

test('audio hardware clock drifting 100 ppm from the system clock stays on the shared grid for 30 minutes', () => {
  // Cheap phone crystals differ from the system clock by tens of ppm. Without tracking, 100 ppm
  // accumulates 180 ms in 30 minutes: exactly the "el click se corre" symptom.
  const { engine, ctx, clicks, playback } = fixture();
  const rate = 1.0001;
  engine.setPlayback(playback);
  run(engine, ctx, 30 * 60_000, 25, rate);
  const list = active(clicks);
  // Audio time → system time of the moment it sounds → error against the shared grid
  let worst = 0;
  for (const c of list.slice(10)) {
    const wallAt = ((c.time - 10) / rate) * 1000;
    const beat = (epoch + wallAt - playback.startServerTime) / 500;
    worst = Math.max(worst, Math.abs(beat - Math.round(beat)) * 500);
  }
  assert.ok(worst < 3, `click drifted ${worst.toFixed(2)} ms from the room grid`);
  assert.equal(new Set(list.map((c) => c.key)).size, list.length, 'no duplicate beats while tracking drift');
  engine.stop();
});

test('count-in: quarter notes only, drumstick sound, beat 1 accented, then the song pattern', () => {
  const { engine, ctx, clicks, playback } = fixture();
  const beats: any[] = [];
  engine.onBeat((info: any) => beats.push(info));
  engine.setPlayback({ ...playback, countInBeats: 4, subdivision: '2', accentPattern: [1, 1, 2, 1] });
  run(engine, ctx, 4500);
  const list = active(clicks);
  const countIn = list.slice(0, 4);
  assert.deepEqual(countIn.map((c) => c.accent), [2, 1, 1, 1]);
  assert.ok(countIn.every((c) => c.preset === 'drumstick' && !c.subdivision));
  for (let i = 1; i < 4; i++) assert.ok(Math.abs(countIn[i].time - countIn[i - 1].time - 0.5) < 0.001, 'no eighths during count-in');
  // After the count-in: eighths, song accents (beat 3 accented), default sound
  const song = list.slice(4, 12);
  assert.ok(Math.abs(song[0].time - (10.2 + 2)) < 0.001);
  assert.deepEqual(song.map((c) => c.subdivision), [false, true, false, true, false, true, false, true]);
  assert.deepEqual(song.filter((c) => !c.subdivision).map((c) => c.accent), [1, 1, 2, 1]);
  assert.ok(song.every((c) => c.preset === undefined));
  // Visual count-in info counts down 3,2,1,0
  for (const t of [...timers.values()]) t.callback();
  const visualCountIn = beats.filter((b) => b.isCountIn);
  assert.deepEqual(visualCountIn.map((b) => b.countInBeatsLeft), [3, 2, 1, 0]);
  engine.stop();
});

test('a silent beat (accent 0) mutes the beat and its subdivisions but keeps the visual', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback({ ...playback, subdivision: '4', accentPattern: [2, 0, 1, 1] });
  run(engine, ctx, 2400);
  const list = active(clicks);
  const inSecondBeat = list.filter((c) => c.time >= 10.7 - 0.001 && c.time < 11.2 - 0.001);
  assert.equal(inSecondBeat.length, 0);
  assert.equal(list.filter((c) => c.time >= 10.2 - 0.001 && c.time < 10.7 - 0.001).length, 4, 'sixteenths on beat 1');
  engine.stop();
});

test('triplets and sixteenths are evenly spaced', () => {
  for (const [sub, n] of [['3', 3], ['4', 4], ['2', 2]] as const) {
    const { engine, ctx, clicks, playback } = fixture();
    engine.setPlayback({ ...playback, bpm: 100, subdivision: sub });
    run(engine, ctx, 6000);
    const list = active(clicks);
    for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i].time - list[i - 1].time - 0.6 / n) < 0.0005);
    engine.stop();
  }
});

test('muting stops the sound but the screen keeps the beat', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setMuted(true);
  engine.setPlayback(playback);
  run(engine, ctx, 2000);
  assert.equal(clicks.length, 0);
  assert.ok(timers.size > 0, 'visual beats still scheduled');
  engine.stop();
});

test('personal fine offset plays the click earlier and is applied live', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  run(engine, ctx, 300);
  assert.ok(Math.abs(active(clicks)[1].time - 10.7) < 0.001);
  engine.setBluetoothOffset(40);
  const after = active(clicks).filter((c) => c.time > ctx.currentTime + 0.01);
  assert.ok(after.length > 0);
  for (const c of after) {
    const beat = (c.time + 0.04 - 10.2) / 0.5;
    assert.ok(Math.abs(beat - Math.round(beat)) < 0.002, `click at ${c.time} is not 40 ms before a beat`);
  }
  // Offsets are clamped to the supported range
  engine.setBluetoothOffset(5000);
  assert.equal(engine.getBluetoothOffset(), 350);
  engine.setBluetoothOffset(-5000);
  assert.equal(engine.getBluetoothOffset(), -150);
  engine.stop();
});

test('stop cancels every queued click and visual beat', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  run(engine, ctx, 500);
  engine.stop();
  assert.ok(clicks.every((c) => c.canceled || c.time <= ctx.currentTime));
  assert.equal(engine.visualTimers.size, 0);
  const before = clicks.length;
  run(engine, ctx, 2000);
  assert.equal(clicks.length, before, 'nothing scheduled after stop');
});

test('repeated identical room updates never duplicate or restart clicks', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  for (let i = 0; i < 50; i++) {
    run(engine, ctx, wallMs + 40);
    engine.setPlayback({ ...playback });
  }
  const list = active(clicks);
  assert.equal(new Set(list.map((c) => c.key)).size, list.length);
  for (let i = 1; i < list.length; i++) assert.ok(Math.abs(list[i].time - list[i - 1].time - 0.5) < 0.001);
  engine.stop();
});

test('small clock corrections while playing are slewed (≤3 ms per update), big ones re-plan', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setServerTimeOffset(0);
  engine.setPlayback(playback);
  run(engine, ctx, 300);
  engine.setServerTimeOffset(20);
  assert.equal(engine.getDiagnostics().serverOffsetMs, 3);
  engine.setServerTimeOffset(1.5); // under 2 ms of difference: ignored
  assert.equal(engine.getDiagnostics().serverOffsetMs, 3);
  const before = active(clicks).length;
  engine.setServerTimeOffset(500);
  assert.equal(engine.getDiagnostics().serverOffsetMs, 500);
  assert.ok(active(clicks).length <= before + 10, 're-planned, not stacked');
  const list = active(clicks);
  assert.equal(new Set(list.map((c) => c.key)).size, list.length);
  engine.stop();
});

test('re-planning for a drifting clock never drops or duplicates a beat', () => {
  // The engine re-plans queued clicks whenever its audio-clock estimate moves. If it cancelled a
  // click that is about to sound, the scheduler could not re-add it in time and the beat would be
  // silently missing, which is far worse than being 2 ms out.
  const { engine, ctx, clicks, playback } = fixture();
  ctx.outputLatency = 0;
  let noise = 0;
  // Output timestamps wander by several ms, as a real device's do
  ctx.getOutputTimestamp = () => {
    noise = (noise + 1) % 8;
    return { contextTime: ctx.currentTime - 0.05 + noise * 0.0015, performanceTime: wallMs - 5 };
  };
  engine.setPlayback(playback);
  run(engine, ctx, 60_000);
  const list = active(clicks);
  assert.ok(list.length > 100, `only ${list.length} clicks`);
  assert.equal(new Set(list.map((c) => c.key)).size, list.length, 'a beat was scheduled twice');
  for (let i = 1; i < list.length; i++) {
    const gap = list[i].time - list[i - 1].time;
    assert.ok(Math.abs(gap - 0.5) < 0.02, `beat ${i} is ${(gap * 1000).toFixed(1)} ms after the previous one`);
  }
  engine.stop();
});

test('stopping and starting again begins on the new anchor, not the old one', () => {
  const { engine, ctx, clicks, playback } = fixture();
  engine.setPlayback(playback);
  run(engine, ctx, 1000);
  engine.setPlayback({ ...playback, isPlaying: false, startServerTime: null });
  const before = clicks.length;
  engine.setPlayback({ ...playback, startServerTime: epoch + 3000 });
  run(engine, ctx, 4000);
  const fresh = active(clicks.slice(before));
  assert.ok(Math.abs(fresh[0].time - 13) < 0.001);
  engine.stop();
});
