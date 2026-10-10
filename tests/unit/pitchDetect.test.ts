/**
 * Feeds the detector synthetic signals with a known frequency. This checks the maths, not the
 * microphone: a real string also brings room noise, fret buzz and a decaying envelope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPitch, describeNote, nearestString, minBufferLength, TUNINGS } from '../../src/utils/pitchDetect.ts';

const RATE = 48_000;

/** A note with harmonics, which is what a string actually produces. */
function tone(hz: number, { harmonics = [1, 0.5, 0.25], amplitude = 0.3, rate = RATE, length = minBufferLength(RATE) } = {}) {
  const buf = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sample = 0;
    harmonics.forEach((gain, h) => {
      sample += gain * Math.sin((2 * Math.PI * hz * (h + 1) * i) / rate);
    });
    buf[i] = amplitude * sample;
  }
  return buf;
}

const centsOff = (detected: number, expected: number) => Math.abs(1200 * Math.log2(detected / expected));

test('detects every string of guitar, bass and ukulele within a cent', () => {
  for (const [instrument, strings] of Object.entries(TUNINGS)) {
    for (const s of strings) {
      const reading = detectPitch(tone(s.hz), RATE);
      assert.ok(reading, `${instrument} ${s.label} (${s.hz} Hz) was not detected at all`);
      const off = centsOff(reading.hz, s.hz);
      assert.ok(off < 1, `${instrument} ${s.label}: off by ${off.toFixed(2)} cents`);
    }
  }
});

test('a weak fundamental does not drop the reading an octave', () => {
  // A plucked low E is mostly harmonics; plain autocorrelation reports 41 Hz as 20.6 Hz
  const buf = tone(82.41, { harmonics: [0.15, 1, 0.8, 0.6] });
  const reading = detectPitch(buf, RATE);
  assert.ok(reading);
  assert.ok(centsOff(reading.hz, 82.41) < 5, `reported ${reading.hz.toFixed(2)} Hz instead of 82.41`);
});

test('silence, noise and a too-short buffer report nothing rather than a wrong note', () => {
  assert.equal(detectPitch(new Float32Array(minBufferLength(RATE)), RATE), null, 'silence');

  const quiet = tone(440, { amplitude: 0.001 });
  assert.equal(detectPitch(quiet, RATE), null, 'a note below the noise floor');

  let seed = 7;
  const noise = new Float32Array(minBufferLength(RATE));
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    noise[i] = (seed / 2147483648) * 2 - 1;
  }
  assert.equal(detectPitch(noise, RATE), null, 'white noise is not a note');

  assert.equal(detectPitch(tone(440, { length: 2048 }), RATE), null, 'a buffer too short for the low range');
});

test('cents are signed, and the octave numbering puts A440 in the fourth', () => {
  const inTune = describeNote({ hz: 440, clarity: 1 });
  assert.equal(inTune.name, 'La');
  assert.equal(inTune.octave, 4);
  assert.equal(inTune.cents, 0);

  // A quarter-tone is 50 cents; just under it must still name the lower note
  assert.equal(describeNote({ hz: 440 * Math.pow(2, 20 / 1200), clarity: 1 }).cents, 20, 'sharp reads positive');
  assert.equal(describeNote({ hz: 440 * Math.pow(2, -20 / 1200), clarity: 1 }).cents, -20, 'flat reads negative');
  assert.equal(describeNote({ hz: 82.41, clarity: 1 }).name, 'Mi');
  assert.equal(describeNote({ hz: 82.41, clarity: 1 }).octave, 2);

  // A different reference pitch moves every reading with it
  assert.equal(describeNote({ hz: 440, clarity: 1 }, 442).cents, -8);
});

test('the suggested string is the closest one, and far-off notes suggest none', () => {
  assert.equal(nearestString(330, TUNINGS.guitarra)?.hz, 329.63);
  assert.equal(nearestString(100, TUNINGS.guitarra)?.hz, 110.0, 'halfway up it still picks a side');
  assert.equal(nearestString(44, TUNINGS.guitarra), null, 'below the guitar there is nothing to suggest');
  assert.equal(nearestString(41.5, TUNINGS.bajo)?.hz, 41.2);
});
