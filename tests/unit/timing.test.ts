import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBarStart, monotonicNowMs } from '../../src/utils/timing.ts';

const fourFour = { numerator: 4, denominator: 4 };

test('nextBarStart: not playing returns null', () => {
  assert.equal(nextBarStart({ startServerTime: null, bpm: 120, timeSignature: fourFour }, 1000, 350), null);
});

test('nextBarStart: before the first beat keeps the anchor (values apply from the start)', () => {
  assert.equal(nextBarStart({ startServerTime: 10_000, bpm: 120, timeSignature: fourFour }, 9_000, 350), 10_000);
  // Exactly at the lead boundary still counts as "not started"
  assert.equal(nextBarStart({ startServerTime: 10_000, bpm: 120, timeSignature: fourFour }, 9_650, 350), 10_000);
});

test('nextBarStart: lands on a bar line at least leadMs away', () => {
  // 120 BPM 4/4 → bar = 2000 ms. Now = start + 500 → target 850 → next bar at +2000
  assert.equal(nextBarStart({ startServerTime: 0, bpm: 120, timeSignature: fourFour }, 500, 350), 2000);
  // Too close to the next bar (needs 350 ms notice) → skips to the one after
  assert.equal(nextBarStart({ startServerTime: 0, bpm: 120, timeSignature: fourFour }, 1800, 350), 4000);
  // Exactly on the lead → that bar
  assert.equal(nextBarStart({ startServerTime: 0, bpm: 120, timeSignature: fourFour }, 1650, 350), 2000);
});

test('nextBarStart: respects the meter (3/4 and 7/8 count quarter-note beats of 60000/bpm)', () => {
  assert.equal(nextBarStart({ startServerTime: 0, bpm: 60, timeSignature: { numerator: 3, denominator: 4 } }, 100, 350), 3000);
  assert.equal(nextBarStart({ startServerTime: 0, bpm: 120, timeSignature: { numerator: 7, denominator: 8 } }, 100, 350), 3500);
});

test('nextBarStart: result is always a whole number of bars after the anchor', () => {
  for (const bpm of [30, 61, 97, 133, 177, 300]) {
    for (const num of [1, 2, 3, 5, 7, 12, 16]) {
      const barMs = (60_000 / bpm) * num;
      for (let now = 0; now < 60_000; now += 997) {
        const next = nextBarStart({ startServerTime: 1_000, bpm, timeSignature: { numerator: num, denominator: 4 } }, 1_000 + now, 350)!;
        const bars = (next - 1_000) / barMs;
        assert.ok(Math.abs(bars - Math.round(bars)) * barMs <= 0.5, `bpm ${bpm} ${num}: off grid by ${bars}`);
        assert.ok(next >= 1_000 + now + 350 - 0.5, 'change must have at least leadMs notice');
        assert.ok(next < 1_000 + now + 350 + barMs + 0.5, 'change must land on the first eligible bar');
      }
    }
  }
});

test('monotonicNowMs is close to Date.now and never goes backwards', () => {
  assert.ok(Math.abs(monotonicNowMs() - Date.now()) < 1000);
  let prev = monotonicNowMs();
  for (let i = 0; i < 10_000; i++) {
    const now = monotonicNowMs();
    assert.ok(now >= prev);
    prev = now;
  }
});
