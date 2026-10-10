/**
 * Monophonic pitch detection for the tuner, using the normalised square difference function
 * (McLeod). Plain autocorrelation locks onto the octave below on a guitar's low strings, where the
 * fundamental is often weaker than its harmonics; NSDF normalises each lag and picks the *first*
 * strong peak, which is the fundamental.
 */

/** Lowest note worth chasing: a 5-string bass low B is 30.87 Hz. */
const MIN_HZ = 28;
/** Highest: well above a guitar's 24th fret (E6, 1318 Hz). */
const MAX_HZ = 1400;
/** Samples correlated at each lag. Longer is steadier, shorter follows a fast retune. */
const WINDOW = 2048;
/** Below this the signal is noise or a dying note, and a reading would only flicker. */
const MIN_RMS = 0.008;
/** How peaky the NSDF must be before we call it a note rather than a chord or a hiss. */
const MIN_CLARITY = 0.8;

const NOTE_NAMES = ['Do', 'Do#', 'Re', 'Re#', 'Mi', 'Fa', 'Fa#', 'Sol', 'Sol#', 'La', 'La#', 'Si'];

export interface PitchReading {
  hz: number;
  /** 0..1, how confident the detector is. */
  clarity: number;
}

export interface NoteReading extends PitchReading {
  /** Spanish note name, e.g. "La". */
  name: string;
  /** Scientific octave, so A440 is La4. */
  octave: number;
  /** Distance to the nearest semitone, -50..50. Negative is flat. */
  cents: number;
}

/**
 * The shortest buffer `detectPitch` can use. A shorter one cannot hold a full period of the lowest
 * note plus the correlation window, so low strings would simply never register.
 */
export function minBufferLength(sampleRate: number): number {
  return WINDOW + Math.ceil(sampleRate / MIN_HZ);
}

/** Returns the detected frequency, or null when there is nothing clear enough to report. */
export function detectPitch(buffer: Float32Array, sampleRate: number): PitchReading | null {
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_HZ), buffer.length - WINDOW);
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  if (maxLag <= minLag) return null;

  let power = 0;
  for (let i = 0; i < WINDOW; i++) power += buffer[i] * buffer[i];
  if (Math.sqrt(power / WINDOW) < MIN_RMS) return null;

  // nsdf[lag] approaches 1 where the signal repeats itself
  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    let energy = 0;
    for (let i = 0; i < WINDOW; i++) {
      const a = buffer[i];
      const b = buffer[i + lag];
      corr += a * b;
      energy += a * a + b * b;
    }
    nsdf[lag] = energy > 0 ? (2 * corr) / energy : 0;
  }

  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) if (nsdf[lag] > best) best = nsdf[lag];
  if (best < MIN_CLARITY) return null;

  // The first peak that gets close to the strongest one is the fundamental; later peaks are its
  // own repeats, and taking the tallest instead is what drops a reading an octave.
  const threshold = best * 0.9;
  let peak = -1;
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (nsdf[lag] >= threshold && nsdf[lag] >= nsdf[lag - 1] && nsdf[lag] >= nsdf[lag + 1]) {
      peak = lag;
      break;
    }
  }
  if (peak < 0) return null;

  // Parabolic interpolation: without it the reading jumps in steps of a whole sample, which near
  // the top of the range is worth more than the 1-cent precision a tuner needs.
  const prev = nsdf[peak - 1];
  const next = nsdf[peak + 1];
  const divisor = 2 * (2 * nsdf[peak] - prev - next);
  const refined = divisor !== 0 ? peak + (next - prev) / divisor : peak;

  const hz = sampleRate / refined;
  if (!Number.isFinite(hz) || hz < MIN_HZ || hz > MAX_HZ) return null;
  return { hz, clarity: Math.min(1, best) };
}

/** Names a frequency and says how far off the nearest semitone it is, in cents. */
export function describeNote(reading: PitchReading, referenceA = 440): NoteReading {
  const midi = 69 + 12 * Math.log2(reading.hz / referenceA);
  const nearest = Math.round(midi);
  return {
    ...reading,
    name: NOTE_NAMES[((nearest % 12) + 12) % 12],
    octave: Math.floor(nearest / 12) - 1,
    cents: Math.round((midi - nearest) * 100),
  };
}

export interface TunerString {
  label: string;
  hz: number;
}

/** Standard tunings, lowest string first. */
export const TUNINGS: Record<string, TunerString[]> = {
  guitarra: [
    { label: 'Mi', hz: 82.41 },
    { label: 'La', hz: 110.0 },
    { label: 'Re', hz: 146.83 },
    { label: 'Sol', hz: 196.0 },
    { label: 'Si', hz: 246.94 },
    { label: 'Mi', hz: 329.63 },
  ],
  bajo: [
    { label: 'Mi', hz: 41.2 },
    { label: 'La', hz: 55.0 },
    { label: 'Re', hz: 73.42 },
    { label: 'Sol', hz: 98.0 },
  ],
  ukelele: [
    { label: 'Sol', hz: 392.0 },
    { label: 'Do', hz: 261.63 },
    { label: 'Mi', hz: 329.63 },
    { label: 'La', hz: 440.0 },
  ],
};

/** Which string of the chosen instrument the player is most likely aiming at. */
export function nearestString(hz: number, strings: TunerString[]): TunerString | null {
  let best: TunerString | null = null;
  let bestDistance = Infinity;
  for (const s of strings) {
    // Compared in semitones, so being 10 Hz off matters far more on a bass than up high
    const distance = Math.abs(12 * Math.log2(hz / s.hz));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = s;
    }
  }
  return bestDistance <= 3 ? best : null;
}
