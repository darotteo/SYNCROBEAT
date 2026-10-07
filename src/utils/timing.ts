import { PlaybackState } from '../types/metronome';

/** Monotonic wall-clock in epoch ms (immune to system clock jumps, unlike Date.now()). */
export function monotonicNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function' && performance.timeOrigin) {
    return performance.timeOrigin + performance.now();
  }
  return Date.now();
}

/**
 * When a running metronome changes tempo, meter or song, the change lands on the next bar line
 * (in the old tempo) that is at least `leadMs` away. Returns the new anchor time, or the current
 * one when playback has not started yet.
 */
export function nextBarStart(
  state: Pick<PlaybackState, 'startServerTime' | 'bpm' | 'timeSignature'>,
  nowMs: number,
  leadMs: number
): number | null {
  if (state.startServerTime === null) return null;
  const start = state.startServerTime;
  const barMs = (60_000 / state.bpm) * state.timeSignature.numerator;
  const target = nowMs + leadMs;
  if (target <= start) return start;
  return Math.round(start + Math.ceil((target - start) / barMs) * barMs);
}
