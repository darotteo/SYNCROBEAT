import { PlaybackState, SoundPreset, Subdivision, TimeSignature } from '../types/metronome';
import { monotonicNowMs } from './timing';

export interface BeatInfo {
  beatIndex: number; // Beat within the bar (0-based)
  isAccent: boolean;
  isSubdivision: boolean;
  isCountIn: boolean;
  countInBeatsLeft: number; // Count-in beats still to come after this one (0 when not counting in)
}

export type BeatCallback = (info: BeatInfo) => void;

/** How the count-in sounds on this device: drumsticks or a spoken "1, 2, 3, 4". */
export type CountInSound = 'sticks' | 'voice-es' | 'voice-en';

const MAX_VOICE_NUMBER = 8;

/** One stretch of steady tempo, anchored at `start` (server epoch ms). */
interface Segment {
  start: number;
  bpm: number;
  timeSignature: TimeSignature;
  subdivision: Subdivision;
  accentPattern: number[];
  countInBeats: number;
}

/**
 * Creates an analog-style hyperbolic tangent (tanh) soft-clipping curve.
 * This boosts RMS perceived energy and harmonic density without the harsh,
 * fizzy crackle of digital square-wave clipping.
 */
function createSaturationCurve(amount: number = 2.5): Float32Array {
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  const tanhAmount = Math.tanh(amount);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    curve[i] = Math.tanh(x * amount) / (tanhAmount || 1);
  }
  return curve;
}

/**
 * Half a second of real silence (8 kHz, 8-bit). Looping it switches the iOS Safari audio session from
 * 'ambient' to 'playback', so Web Audio sounds even with the mute switch on. It must contain actual
 * samples: an empty WAV on loop makes the browser restart it endlessly and freezes the page.
 */
function createSilentWavUrl(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate / 2;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);
  new Uint8Array(buffer, 44).fill(128); // 8-bit PCM silence is the midpoint
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
}

function isIOSDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

class AudioEngine {
  private ctx: AudioContext | null = null;
  private isMuted: boolean = false;
  private volume: number = 1.0;
  private isStageBoost: boolean = true; // High-Loudness Stage Booster
  private digitalBoostLevel: number = 2.4; // Digital gain multiplier (1.0x to 3.5x)
  private fineOffsetMs: number = 0; // Personal latency fine-tune in ms (positive = click plays earlier)
  private beatCallbacks: Set<BeatCallback> = new Set();
  private isUnlocked: boolean = false;
  private resumePromise: Promise<void> | null = null;
  private clockStalled = false;
  private lastAudioSample: { time: number; advancedAt: number } | null = null;
  private html5AudioElement: HTMLAudioElement | null = null;
  private keepAliveSource: AudioBufferSourceNode | null = null;
  private stateListeners: Set<(state: AudioContextState) => void> = new Set();

  private isRunning: boolean = false;
  private timerId: number | null = null;
  private workerTimer: Worker | null = null;

  private soundPreset: SoundPreset = 'digital';
  private countInSound: CountInSound = 'sticks';
  private voiceBuffers = new Map<string, AudioBuffer>();
  private voiceRequested = new Set<string>();

  // Synchronization
  /**
   * Tempo timeline in ascending `start` order: [0] is what is sounding now, the rest are hand-overs
   * still ahead. More than one can be pending, because the server anchors each new bar line on the
   * tempo it expects to be running by then — dropping the middle one would shift every later bar.
   */
  private timeline: Segment[] = [];
  private serverTimeOffset: number = 0; // serverTime - monotonicNowMs()
  private hasServerTimeOffset: boolean = false;
  private clockSource: 'output' | 'reported' = 'reported';
  private lastOutputTimestampAt = 0;
  private driftSamples: { at: number; offset: number }[] = [];
  private audioClockOffset: number | null = null; // audioTime - localSec, smoothed (includes output latency)
  private scheduledWithOffset: number | null = null; // audioClockOffset used by the clicks already queued
  private offsetSamples = 0; // Samples since the estimate was (re)seeded; the first ones weigh more
  private recentInstants: number[] = []; // Raw readings behind the median filter

  private warmUpTimer: number | null = null;

  /** Forgets the audio-clock estimate so the next reading seeds it from scratch. */
  private resetAudioClock() {
    this.audioClockOffset = null;
    this.recentInstants = [];
    this.offsetSamples = 0;
  }
  private detectedLatencyMs: number = 0;
  private scheduledAudioBeats = new Set<string>();
  private pendingVoices: { time: number; key: string; cancel: () => void }[] = [];
  private visualTimers = new Map<string, { at: number; id: number }>();

  private readonly LOOKAHEAD_MS = 25;
  // Absorbs short scheduler stalls; the OS can still suspend background audio.
  private readonly SCHEDULE_AHEAD_SEC = 2.0;
  // Visual callbacks are scheduled just in time, independently of audio.
  private readonly SHORT_WINDOW_MS = 150;

  // Master DSP Chain Nodes
  private inputNode: GainNode | null = null;
  private rumbleFilterNode: BiquadFilterNode | null = null;
  private presenceFilterNode: BiquadFilterNode | null = null;
  private digitalGainBoostNode: GainNode | null = null;
  private shaperNode: WaveShaperNode | null = null;
  private limiterNode: DynamicsCompressorNode | null = null;
  private makeupGainNode: GainNode | null = null;

  constructor() {
    try {
      const savedOffset = localStorage.getItem('syncbeat_audio_offset');
      if (savedOffset !== null) {
        this.fineOffsetMs = Math.max(-150, Math.min(350, Number(savedOffset) || 0));
      }
      const savedVol = localStorage.getItem('syncbeat_audio_volume');
      if (savedVol !== null) {
        this.volume = Math.max(0, Math.min(1, Number(savedVol)));
      }
      const savedBoost = localStorage.getItem('syncbeat_stage_boost');
      if (savedBoost !== null) {
        this.isStageBoost = savedBoost === 'true';
      }
      const savedDigitalBoost = localStorage.getItem('syncbeat_digital_boost_level');
      if (savedDigitalBoost !== null) {
        this.digitalBoostLevel = Math.max(1.0, Math.min(3.5, Number(savedDigitalBoost)));
      }
      const savedPreset = localStorage.getItem('syncbeat_sound_preset');
      if (savedPreset && ['woodblock', 'digital', 'cowbell', 'drumstick', 'synth'].includes(savedPreset)) {
        this.soundPreset = savedPreset as SoundPreset;
      }
      const savedCountIn = localStorage.getItem('syncbeat_count_in_sound');
      if (savedCountIn === 'voice-es' || savedCountIn === 'voice-en') {
        this.countInSound = savedCountIn;
      }
    } catch {
      // ignore
    }
    this.setupMobileUnlock();
  }

  /**
   * Continuous unlock listener that handles iOS Safari requirements:
   * 1. Listens on all touch/pointer events, resuming AudioContext if suspended.
   * 2. Plays a silent HTML5 audio element to switch iOS session to 'playback' (bypassing silent switch).
   * 3. Re-unlocks on visibilitychange or window focus if device was locked/interrupted.
   */
  private setupMobileUnlock() {
    if (typeof window === 'undefined') return;

    const unlockHandler = () => {
      this.unlockAudio();
    };

    ['touchstart', 'touchend', 'pointerdown', 'mousedown', 'keydown', 'click'].forEach((event) => {
      window.addEventListener(event, unlockHandler, { capture: true, passive: true });
    });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.ctx) {
          this.unlockAudio();
        }
      });
    }
  }

  /**
   * Activates continuous silent keep-alive node on Web Audio.
   * This is critical for iOS Safari: without continuous processing in the audio graph,
   * Safari suspends AudioDestination within 3 seconds of silence.
   */
  private startWebAudioKeepAlive(ctx: AudioContext) {
    try {
      if (this.keepAliveSource) return;
      const buffer = ctx.createBuffer(1, 44100 * 2, 44100);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.00001, ctx.currentTime);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      this.keepAliveSource = source;
    } catch {}
  }

  /**
   * Explicit audio unlock method callable from UI gestures or click events.
   * Wakes up WebAudio and bypasses the iOS Silent Mode switch.
   */
  public unlockAudio(): boolean {
    try {
      const ctx = this.getAudioContext();
      if (ctx.state !== 'running' && ctx.state !== 'closed') {
        // Call resume() on every gesture. Browsers only accept it on activating events (touchend,
        // click, keydown), not on touchstart / touch pointerdown, and a refused resume() can stay
        // pending forever: waiting for it would block every later tap, so audio never started
        // (Android only worked after a sound preview; iOS stayed silent). Safari's 'interrupted'
        // state is recovered the same way.
        const resume = ctx.resume().catch(() => {});
        this.resumePromise = resume;
        resume.finally(() => {
          if (this.resumePromise === resume) this.resumePromise = null;
        });
      } else if (this.clockStalled && !this.resumePromise) {
        // WebKit can report 'running' even when currentTime has frozen: restart the clock once
        const restart = ctx.suspend().then(() => ctx.resume()).catch(() => {});
        this.resumePromise = restart;
        restart.finally(() => {
          if (this.resumePromise === restart) this.resumePromise = null;
        });
      }

      this.startWebAudioKeepAlive(ctx);

      // Play looping HTML5 Audio to force iOS into continuous 'playback' audio session
      if (!this.html5AudioElement && typeof Audio !== 'undefined') {
        try {
          const audio = new Audio(createSilentWavUrl());
          audio.setAttribute('playsinline', '');
          audio.setAttribute('webkit-playsinline', '');
          (audio as any).playsInline = true;
          audio.loop = true;
          this.html5AudioElement = audio;
        } catch {}
      }

      if (this.html5AudioElement?.paused) {
        this.html5AudioElement.play().catch(() => {});
      }

      this.isUnlocked = true;
      return true;
    } catch {
      return false;
    }
  }

  public isContextRunning(): boolean {
    return !!this.ctx && this.ctx.state === 'running' && !this.clockStalled;
  }

  public onStateChange(listener: (state: AudioContextState) => void) {
    this.stateListeners.add(listener);
    if (this.ctx) {
      listener(this.clockStalled ? 'suspended' : this.ctx.state);
    }
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  public getAudioContext(): AudioContext {
    if (!this.ctx) {
      // Safari 17+: declare a playback session so the click ignores the silent switch
      try {
        const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
        if (session && session.type !== 'playback') session.type = 'playback';
      } catch {}

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      try {
        this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      } catch {
        this.ctx = new AudioCtx();
      }

      this.ctx.onstatechange = () => {
        if (this.ctx) {
          // currentTime freezes on interruption while the shared room continues.
          // Discard its queued audio, then join the current phase on recovery.
          this.cancelFutureVoices(true);
          this.scheduledAudioBeats.clear();
          this.resetAudioClock();
          this.clockStalled = false;
          this.lastAudioSample = null;
          this.stateListeners.forEach((l) => l(this.ctx!.state));
          if (this.ctx.state === 'running') {
            this.isUnlocked = true;
            if (this.isRunning) this.scheduler();
          }
        }
      };

      this.initMasterChain(this.ctx);
      this.startWebAudioKeepAlive(this.ctx);
      this.startClockWarmUp();
      this.preloadVoice();
    }
    return this.ctx;
  }

  /**
   * Initializes high-headroom Stage DSP Chain with iOS-safe fallbacks:
   * Input -> Rumble -> Presence -> Gain -> Shaper -> Limiter -> Makeup -> Output
   * If any WebKit node fails, falls back gracefully directly to destination so audio never mutes.
   */
  private initMasterChain(ctx: AudioContext) {
    try {
      this.inputNode = ctx.createGain();
      this.inputNode.gain.setValueAtTime(this.userGain(), ctx.currentTime);

      if (isIOSDevice()) {
        // Safe, clean chain for iOS to prevent WebKit AudioNode bugs/silence
        const iosLimiter = ctx.createDynamicsCompressor();
        iosLimiter.threshold.setValueAtTime(-1.0, ctx.currentTime);
        iosLimiter.ratio.setValueAtTime(12, ctx.currentTime);

        const presenceFilter = ctx.createBiquadFilter();
        presenceFilter.type = 'peaking';
        presenceFilter.frequency.setValueAtTime(3200, ctx.currentTime);
        presenceFilter.gain.setValueAtTime(3.0, ctx.currentTime);

        this.inputNode.connect(presenceFilter);
        presenceFilter.connect(iosLimiter);
        iosLimiter.connect(ctx.destination);
        return;
      }

      // Rumble filter: remove low frequencies that make phone/laptop speakers distort
      this.rumbleFilterNode = ctx.createBiquadFilter();
      this.rumbleFilterNode.type = 'highpass';
      this.rumbleFilterNode.frequency.setValueAtTime(160, ctx.currentTime);
      this.rumbleFilterNode.Q.setValueAtTime(0.7, ctx.currentTime);

      // Presence peak centered at 3.2 kHz (human ear peak sensitivity)
      this.presenceFilterNode = ctx.createBiquadFilter();
      this.presenceFilterNode.type = 'peaking';
      this.presenceFilterNode.frequency.setValueAtTime(3200, ctx.currentTime);
      this.presenceFilterNode.Q.setValueAtTime(1.4, ctx.currentTime);
      const initialPresenceGain = this.isStageBoost ? (4 + (this.digitalBoostLevel - 1) * 2.5) : 2.0;
      this.presenceFilterNode.gain.setValueAtTime(initialPresenceGain, ctx.currentTime);

      this.digitalGainBoostNode = ctx.createGain();
      const effectiveGain = this.isStageBoost ? this.digitalBoostLevel : 1.0;
      this.digitalGainBoostNode.gain.setValueAtTime(effectiveGain, ctx.currentTime);

      this.shaperNode = ctx.createWaveShaper();
      const satAmount = this.isStageBoost ? Math.min(4.5, 1.8 + this.digitalBoostLevel * 0.8) : 1.5;
      this.shaperNode.curve = createSaturationCurve(satAmount) as Float32Array<ArrayBuffer>;

      // Brickwall limiter to avoid DAC clipping
      this.limiterNode = ctx.createDynamicsCompressor();
      this.limiterNode.threshold.setValueAtTime(-0.3, ctx.currentTime);
      this.limiterNode.knee.setValueAtTime(0, ctx.currentTime);
      this.limiterNode.ratio.setValueAtTime(20, ctx.currentTime);
      this.limiterNode.attack.setValueAtTime(0.0003, ctx.currentTime);
      this.limiterNode.release.setValueAtTime(0.020, ctx.currentTime);

      this.makeupGainNode = ctx.createGain();
      const initialMakeup = this.isStageBoost ? Math.min(1.85, 1.2 + this.digitalBoostLevel * 0.15) : 1.1;
      this.makeupGainNode.gain.setValueAtTime(initialMakeup, ctx.currentTime);

      this.inputNode.connect(this.rumbleFilterNode);
      this.rumbleFilterNode.connect(this.presenceFilterNode);
      this.presenceFilterNode.connect(this.digitalGainBoostNode);
      this.digitalGainBoostNode.connect(this.shaperNode);
      this.shaperNode.connect(this.limiterNode);
      this.limiterNode.connect(this.makeupGainNode);
      this.makeupGainNode.connect(ctx.destination);
    } catch {
      // Fallback: connect input directly to destination
      try {
        if (!this.inputNode) {
          this.inputNode = ctx.createGain();
          this.inputNode.gain.setValueAtTime(this.userGain(), ctx.currentTime);
        }
        this.inputNode.connect(ctx.destination);
      } catch {}
    }
  }

  private applyBoostParameters() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const effectiveGain = this.isStageBoost ? this.digitalBoostLevel : 1.0;

    if (this.digitalGainBoostNode) {
      this.digitalGainBoostNode.gain.setTargetAtTime(effectiveGain, now, 0.02);
    }
    if (this.presenceFilterNode) {
      const presenceGain = this.isStageBoost ? (4.5 + (this.digitalBoostLevel - 1) * 2.5) : 2.0;
      this.presenceFilterNode.gain.setTargetAtTime(presenceGain, now, 0.02);
    }
    if (this.shaperNode) {
      const satAmount = this.isStageBoost ? Math.min(4.5, 1.8 + this.digitalBoostLevel * 0.8) : 1.5;
      this.shaperNode.curve = createSaturationCurve(satAmount) as Float32Array<ArrayBuffer>;
    }
    if (this.makeupGainNode) {
      const makeup = this.isStageBoost ? Math.min(1.85, 1.2 + this.digitalBoostLevel * 0.15) : 1.1;
      this.makeupGainNode.gain.setTargetAtTime(makeup, now, 0.02);
    }
  }

  private getMasterInputNode(): AudioNode {
    const ctx = this.getAudioContext();
    if (!this.inputNode) {
      this.initMasterChain(ctx);
    }
    return this.inputNode!;
  }

  /**
   * Volume and mute ride on the shared input node instead of on each click, so a change also
   * reaches the clicks already queued (the scheduler works up to `SCHEDULE_AHEAD_SEC` ahead).
   */
  private userGain(): number {
    return this.isMuted ? 0 : this.volume;
  }

  private applyUserGain() {
    if (!this.inputNode || !this.ctx) return;
    const now = this.ctx.currentTime;
    try {
      this.inputNode.gain.cancelScheduledValues(now);
      // A few ms of ramp: perceptually immediate, without the click a hard step would make
      this.inputNode.gain.setTargetAtTime(this.userGain(), now, 0.008);
    } catch {}
  }

  public setMuted(muted: boolean) {
    this.isMuted = muted;
    this.applyUserGain();
  }

  public getMuted(): boolean {
    return this.isMuted;
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    this.applyUserGain();
    try {
      localStorage.setItem('syncbeat_audio_volume', String(this.volume));
    } catch {}
  }

  public getVolume(): number {
    return this.volume;
  }

  public setStageBoost(boost: boolean) {
    this.isStageBoost = boost;
    try {
      localStorage.setItem('syncbeat_stage_boost', String(boost));
    } catch {}
    this.applyBoostParameters();
  }

  public getStageBoost(): boolean {
    return this.isStageBoost;
  }

  public setDigitalGainBoost(level: number) {
    this.digitalBoostLevel = Math.max(1.0, Math.min(3.5, level));
    try {
      localStorage.setItem('syncbeat_digital_boost_level', String(this.digitalBoostLevel));
    } catch {}
    this.applyBoostParameters();
  }

  public getDigitalGainBoost(): number {
    return this.digitalBoostLevel;
  }

  /** Personal sound choice; never shared with the room. */
  public setSoundPreset(preset: SoundPreset) {
    this.soundPreset = preset;
    try {
      localStorage.setItem('syncbeat_sound_preset', preset);
    } catch {}
    this.reschedule();
  }

  public getSoundPreset(): SoundPreset {
    return this.soundPreset;
  }

  public setCountInSound(sound: CountInSound) {
    this.countInSound = sound;
    try {
      localStorage.setItem('syncbeat_count_in_sound', sound);
    } catch {}
    this.preloadVoice();
    this.reschedule();
  }

  public getCountInSound(): CountInSound {
    return this.countInSound;
  }

  /** Plays one count-in number with the current setting, so it can be previewed. */
  public previewCountIn(n: number = 1) {
    const ctx = this.getAudioContext();
    const time = ctx.currentTime + 0.05;
    if (!this.playVoiceNumber(time, n)) this.playSynthesizedClick(time, n === 1 ? 2 : 1, false, undefined, 'drumstick');
  }

  /** Spoken numbers are bundled audio files, decoded once so they can be scheduled sample-accurately. */
  private preloadVoice() {
    if (this.countInSound === 'sticks' || !this.ctx) return;
    const ctx = this.ctx;
    const lang = this.countInSound === 'voice-es' ? 'es' : 'en';
    for (let n = 1; n <= MAX_VOICE_NUMBER; n++) {
      const key = `${lang}-${n}`;
      if (this.voiceRequested.has(key)) continue;
      this.voiceRequested.add(key);
      fetch(`/voice/${key}.wav`)
        .then((res) => (res.ok ? res.arrayBuffer() : Promise.reject(new Error(res.statusText))))
        .then(
          (data) =>
            new Promise<AudioBuffer>((resolve, reject) => {
              // Callback form for older Safari
              ctx.decodeAudioData(data, resolve, reject);
            })
        )
        .then((buffer) => this.voiceBuffers.set(key, buffer))
        .catch(() => this.voiceRequested.delete(key));
    }
  }

  /** Returns false when the voice is off or not loaded yet (caller falls back to sticks). */
  private playVoiceNumber(time: number, n: number, key?: string): boolean {
    if (this.countInSound === 'sticks' || n < 1 || n > MAX_VOICE_NUMBER || !this.ctx) return false;
    const lang = this.countInSound === 'voice-es' ? 'es' : 'en';
    const buffer = this.voiceBuffers.get(`${lang}-${n}`);
    if (!buffer || this.ctx.state !== 'running') return false;

    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1.6, time); // Volume lives on the shared input node
    source.connect(gain);
    gain.connect(this.getMasterInputNode());
    source.start(time);

    if (key) {
      this.pendingVoices.push({
        time,
        key,
        cancel: () => {
          try {
            source.stop();
            gain.disconnect();
          } catch {}
        },
      });
    }
    return true;
  }

  /** Manual fine-tune on top of the automatically detected device latency. */
  public setBluetoothOffset(offsetMs: number) {
    this.fineOffsetMs = Math.max(-150, Math.min(350, Math.round(offsetMs)));
    try {
      localStorage.setItem('syncbeat_audio_offset', String(this.fineOffsetMs));
    } catch {}
    this.reschedule();
  }

  public getBluetoothOffset(): number {
    return this.fineOffsetMs;
  }

  /** Output latency the browser reports for this device (speaker/headphones), compensated automatically. */
  public getDetectedLatencyMs(): number {
    if (!this.isRunning && this.ctx && this.ctx.state === 'running') this.updateAudioClockOffset(this.ctx);
    return this.detectedLatencyMs;
  }

  public playTestClick(accent: boolean = true) {
    const ctx = this.getAudioContext();
    this.playSynthesizedClick(ctx.currentTime + 0.015, accent ? 2 : 1, false);
  }

  public previewClick() {
    const ctx = this.getAudioContext();
    const play = () => this.playSynthesizedClick(ctx.currentTime + 0.02, 2, false);
    if (ctx.state === 'suspended') {
      ctx.resume().then(play).catch(play);
    } else {
      play();
    }
  }

  // -------------------------------------------------------------------------
  // Clock synchronization
  // -------------------------------------------------------------------------

  /** Current time on the shared server clock (epoch ms). */
  public serverNow(): number {
    return monotonicNowMs() + this.serverTimeOffset;
  }

  public setServerTimeOffset(offsetMs: number) {
    if (!Number.isFinite(offsetMs)) return;
    if (!this.isRunning || !this.hasServerTimeOffset) {
      const changed = offsetMs !== this.serverTimeOffset;
      this.serverTimeOffset = offsetMs;
      this.hasServerTimeOffset = true;
      if (changed && this.isRunning) this.reschedule();
      return;
    }
    // While playing, slew gently so the beat never jumps audibly
    const diff = offsetMs - this.serverTimeOffset;
    if (Math.abs(diff) < 2) return;
    if (Math.abs(diff) > 80) {
      this.serverTimeOffset = offsetMs;
      this.reschedule();
    } else {
      this.serverTimeOffset += Math.sign(diff) * Math.min(3, Math.abs(diff) * 0.25);
    }
  }

  /**
   * Maps the local monotonic clock to the audio clock at the moment sound leaves the speaker.
   * Uses getOutputTimestamp() (includes the device's output latency) when it looks sane, otherwise
   * currentTime minus the reported output latency. Smoothed to remove render-quantum jitter.
   */
  private updateAudioClockOffset(ctx: AudioContext) {
    const nowMs = monotonicNowMs();
    const rawOffset = ctx.currentTime - nowMs / 1000;
    const reportedLatencySec = Math.max(0, (ctx.outputLatency || 0) + (ctx.baseLatency || 0));

    let outputOffset: number | null = null;
    try {
      const ts = ctx.getOutputTimestamp?.();
      const ageMs = typeof ts?.performanceTime === 'number' ? performance.now() - ts.performanceTime : Infinity;
      if (ts && typeof ts.contextTime === 'number' && Number.isFinite(ts.contextTime) && ts.contextTime > 0 &&
          typeof ts.performanceTime === 'number' && Number.isFinite(ts.performanceTime) && ts.performanceTime > 0 &&
          ageMs >= -20 && ageMs <= 250) {
        const outputNow = ts.contextTime + ageMs / 1000;
        if (outputNow <= ctx.currentTime + 0.02 && ctx.currentTime - outputNow < 1) {
          // This timestamp already maps audible output: no latency to subtract.
          outputOffset = ts.contextTime - (performance.timeOrigin + ts.performanceTime) / 1000;
        }
      }
    } catch {}

    // The two estimators differ by the output latency. Switching between them tick by tick (Safari
    // sometimes returns stale timestamps) would move the beat back and forth, so once output
    // timestamps work they are the only source, and a missing one just keeps the last value.
    let instant: number;
    const previousSource = this.clockSource;
    if (outputOffset !== null) {
      this.lastOutputTimestampAt = nowMs;
      this.clockSource = 'output';
      instant = outputOffset;
      this.detectedLatencyMs = Math.max(0, Math.round((rawOffset - outputOffset) * 1000));
    } else if (this.clockSource === 'output' && nowMs - this.lastOutputTimestampAt < 3000 && this.audioClockOffset !== null) {
      this.trackClockDrift(nowMs);
      return;
    } else {
      this.clockSource = 'reported';
      instant = rawOffset - reportedLatencySec;
      this.detectedLatencyMs = Math.round(reportedLatencySec * 1000);
    }

    // Output timestamps only become valid a moment after the audio starts. The two estimators differ
    // by the real output latency, so switching source is a jump too: smoothing it in would leave the
    // first seconds of playback tens of ms off the rest of the band.
    const sourceChanged = previousSource !== this.clockSource;
    // A median of the last few readings: single noisy samples (common while the audio hardware is
    // starting) cannot move the estimate, but a genuine shift is followed within a few ticks.
    // The window spans ~225 ms of scheduler ticks: long enough to outvote a browser that reports
    // its output timestamp one audio buffer (~21 ms on Windows) out of place for a moment, which
    // would otherwise shift this device's clicks away from the rest of the band. A real route
    // change moves the reading much further and is caught by the jump check below instead.
    this.recentInstants.push(instant);
    if (this.recentInstants.length > 9) this.recentInstants.shift();
    const sorted = [...this.recentInstants].sort((a, b) => a - b);
    instant = sorted[Math.floor(sorted.length / 2)];

    if (this.audioClockOffset === null || sourceChanged || Math.abs(instant - this.audioClockOffset) > 0.08) {
      // Real jump (audio route changed, clock resumed): replan what has not started yet
      if (this.audioClockOffset !== null) this.cancelFutureVoices();
      this.audioClockOffset = instant;
      this.scheduledWithOffset = null;
      this.offsetSamples = 0;
      this.recentInstants = [instant];
      this.driftSamples = [];
    } else {
      // The first readings after the audio hardware starts are unreliable (measured up to ~170 ms
      // out). Averaging them in would drag the estimate for seconds, so they are replaced outright
      // by the newest reading; only once the readings have settled does this become a running mean
      // that filters jitter.
      this.offsetSamples++;
      const SETTLING_SAMPLES = 15;
      const weight =
        this.offsetSamples <= SETTLING_SAMPLES ? 1 : Math.max(0.05, 1 / (this.offsetSamples - SETTLING_SAMPLES + 1));
      this.audioClockOffset += (instant - this.audioClockOffset) * weight;
      // Clicks are queued up to SCHEDULE_AHEAD_SEC in advance. The first estimate right after the
      // audio starts can be ~15 ms out, and each device is wrong by a different amount, so those
      // first two seconds would be audibly apart from the rest of the band. Once the estimate has
      // moved meaningfully, re-plan whatever has not started yet with the better mapping.
      // Queued clicks follow the estimate as it settles. Measured on a desktop, the estimate starts
      // up to ~170 ms out and takes about two seconds to converge, so clicks planned at the start
      // of a song would otherwise be audibly apart from the rest of the band. Re-planning in small
      // steps keeps each correction under the 2 ms threshold, which is inaudible; stopping early
      // instead leaves one bigger step at the cut-off, which is not. In steady state the estimate
      // only creeps (clock drift is parts per million) so this rarely fires. Only clicks still
      // comfortably ahead are moved: the scheduler ticks every 25 ms, so a 100 ms horizon
      // guarantees it can re-add them, and dropping a beat would be far worse than being 2 ms out.
      if (this.scheduledWithOffset !== null && Math.abs(this.audioClockOffset - this.scheduledWithOffset) > 0.002) {
        this.cancelFutureVoices(false, 0.1);
        this.scheduledWithOffset = this.audioClockOffset;
      }
    }
    this.trackClockDrift(nowMs);
  }

  /**
   * Keeps measuring the audio clock while the metronome is stopped, so the mapping is already
   * settled when the room starts playing. Without this the first clicks of a song use a cold
   * estimate (measured ~10 ms out), and since each device is wrong by a different amount the band
   * hears a flam for the first couple of seconds.
   */
  private startClockWarmUp() {
    if (this.warmUpTimer !== null || typeof window === 'undefined') return;
    this.warmUpTimer = window.setInterval(() => {
      const ctx = this.ctx;
      // While playing, the scheduler already samples it on every tick
      if (!ctx || this.isRunning || ctx.state !== 'running' || this.clockStalled) return;
      this.updateAudioClockOffset(ctx);
    }, 250);
  }

  /** Samples the audio-vs-system clock offset once a second to report drift in diagnostics. */
  private trackClockDrift(nowMs: number) {
    if (this.audioClockOffset === null) return;
    const last = this.driftSamples[this.driftSamples.length - 1];
    if (last && nowMs - last.at < 1000) return;
    this.driftSamples.push({ at: nowMs, offset: this.audioClockOffset });
    if (this.driftSamples.length > 60) this.driftSamples.shift();
  }

  /** Technical snapshot of the audio clock, shown in settings so iPhone issues can be diagnosed. */
  public getDiagnostics() {
    const ctx = this.ctx;
    let driftPpm: number | null = null;
    if (this.driftSamples.length >= 10) {
      const first = this.driftSamples[0];
      const last = this.driftSamples[this.driftSamples.length - 1];
      const elapsedSec = (last.at - first.at) / 1000;
      if (elapsedSec > 0) driftPpm = Math.round(((last.offset - first.offset) / elapsedSec) * 1e6);
    }
    return {
      state: ctx ? (this.clockStalled ? 'stalled' : ctx.state) : 'none',
      sampleRate: ctx?.sampleRate ?? 0,
      baseLatencyMs: ctx ? Math.round((ctx.baseLatency || 0) * 1000) : 0,
      outputLatencyMs: ctx ? Math.round((ctx.outputLatency || 0) * 1000) : 0,
      clockSource: this.clockSource,
      detectedLatencyMs: this.detectedLatencyMs,
      driftPpm,
      serverOffsetMs: Math.round(this.serverTimeOffset),
      isRunning: this.isRunning,
    };
  }

  /** Audio-context time at which a sound must start to be heard at the given server time. */
  private serverToAudioTime(serverMs: number): number {
    return (serverMs - this.serverTimeOffset) / 1000 + (this.audioClockOffset ?? 0);
  }

  // -------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------

  public onBeat(cb: BeatCallback) {
    this.beatCallbacks.add(cb);
    return () => {
      this.beatCallbacks.delete(cb);
    };
  }

  /**
   * Single entry point for shared playback state. When the anchor moves forward (tempo, meter or
   * song change on the next bar), the previous tempo keeps clicking until the new anchor.
   */
  public setPlayback(state: PlaybackState) {
    if (!state.isPlaying || state.startServerTime === null) {
      this.stop();
      return;
    }

    const next: Segment = {
      start: state.startServerTime,
      bpm: state.bpm,
      timeSignature: state.timeSignature,
      subdivision: state.subdivision,
      accentPattern: state.accentPattern,
      countInBeats: state.countInBeats || 0,
    };

    if (this.isRunning && this.timeline.length) {
      const newest = this.timeline[this.timeline.length - 1];
      if (JSON.stringify(next) === JSON.stringify(newest)) return;
      // A hand-over replaces any planned at or after its own instant, and leaves the earlier ones
      // alone: whatever is clicking right now has to keep clicking until its own hand-over arrives.
      this.timeline = this.timeline.filter((s) => s.start < next.start);
      this.timeline.push(next);
      this.dropElapsedSegments();
      this.reschedule();
      return;
    }

    this.timeline = [next];
    this.start();
  }

  /** Keeps the segment sounding now plus every hand-over still ahead; forgets the ones already over. */
  private dropElapsedSegments() {
    const serverNow = this.serverNow();
    let sounding = 0;
    for (let i = 0; i < this.timeline.length; i++) {
      if (this.timeline[i].start <= serverNow) sounding = i;
    }
    if (sounding > 0) this.timeline.splice(0, sounding);
  }

  private start() {
    this.isRunning = true;
    this.lastAudioSample = null;
    this.cancelFutureVoices();
    this.unlockAudio();

    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'playing';
    }

    this.initWorkerTimer();
    this.workerTimer?.postMessage('start');

    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
    }
    this.scheduler();
    // The worker drives the scheduler; the main-thread timer is only a slower safety net
    this.timerId = window.setInterval(() => this.scheduler(), this.workerTimer ? 200 : this.LOOKAHEAD_MS);
  }

  public stop() {
    this.isRunning = false;
    this.timeline = [];
    this.cancelFutureVoices(true);
    this.scheduledAudioBeats.clear();

    this.workerTimer?.postMessage('stop');

    if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'paused';
    }

    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  /** Drop everything not yet sounding and plan it again with the current settings. */
  private reschedule() {
    this.cancelFutureVoices();
    if (this.isRunning) this.scheduler();
  }

  /**
   * Drops queued clicks so the scheduler can plan them again. `minAheadSec` is how far ahead a
   * click must be to be touched: a click about to sound must be left alone, otherwise the scheduler
   * would not have time to re-add it and the beat would simply be missing.
   */
  private cancelFutureVoices(cancelAll = false, minAheadSec = 0.005) {
    const now = this.ctx ? this.ctx.currentTime : 0;
    const kept: typeof this.pendingVoices = [];
    for (const v of this.pendingVoices) {
      if (cancelAll || v.time > now + minAheadSec) {
        try {
          v.cancel();
        } catch {}
        this.scheduledAudioBeats.delete(v.key);
      } else if (v.time > now - 0.25) {
        kept.push(v);
      }
    }
    this.pendingVoices = kept;

    const nowMs = monotonicNowMs();
    for (const [key, timer] of this.visualTimers) {
      if (cancelAll || timer.at > nowMs) {
        window.clearTimeout(timer.id);
        this.visualTimers.delete(key);
      }
    }
  }

  private initWorkerTimer() {
    if (this.workerTimer || typeof Worker === 'undefined') return;
    try {
      const code = `
        var timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') {
            if (timer) clearInterval(timer);
            timer = setInterval(function() { self.postMessage('tick'); }, ${this.LOOKAHEAD_MS});
          } else if (e.data === 'stop') {
            if (timer) clearInterval(timer);
            timer = null;
          }
        };
      `;
      const blob = new Blob([code], { type: 'application/javascript' });
      this.workerTimer = new Worker(URL.createObjectURL(blob));
      // A worker helps with foreground stalls; iOS can suspend workers too.
      this.workerTimer.onmessage = (e) => {
        if (e.data === 'tick' && this.isRunning) {
          this.scheduler();
        }
      };
    } catch {
      // setInterval alone still works
    }
  }

  public updateMediaSession(info: { title: string; artist: string; album: string; isPlaying: boolean }) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.playbackState = info.isPlaying ? 'playing' : 'paused';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: info.title,
        artist: info.artist,
        album: info.album,
        artwork: [{ src: '/syncrobeat-icon-512.png', sizes: '512x512', type: 'image/png' }],
      });
    } catch {}
  }

  private scheduler() {
    if (!this.isRunning || !this.timeline.length) return;
    this.dropElapsedSegments();

    const ctx = this.getAudioContext();
    // Visual beats keep following the shared clock even while the audio is blocked or recovering
    const audioOk = ctx.state === 'running' && this.checkAudioClock(ctx);
    if (audioOk) this.updateAudioClockOffset(ctx);
    const audioNow = ctx.currentTime;

    const serverNow = this.serverNow();
    const fineOffsetMs = this.fineOffsetMs;
    const audioWindowEndMs = serverNow + this.SCHEDULE_AHEAD_SEC * 1000;
    const visualWindowEndMs = serverNow + this.SHORT_WINDOW_MS;

    // Each segment clicks until the next hand-over; the last one runs on until the room changes it
    const plans: { seg: Segment; end: number }[] = this.timeline.map((seg, i) => ({
      seg,
      end: this.timeline[i + 1]?.start ?? Infinity,
    }));

    for (const { seg, end } of plans) {
      const subPerBeat = parseInt(seg.subdivision, 10) || 1;
      const subMs = 60_000 / seg.bpm / subPerBeat;
      const numerator = Math.max(1, seg.timeSignature.numerator);
      // Audio is sent `fineOffsetMs` early, so look that much further ahead for audio
      const firstIndex = Math.max(0, Math.floor((serverNow + Math.min(0, fineOffsetMs) - 50 - seg.start) / subMs));
      const lastIndex = Math.ceil((Math.max(audioWindowEndMs + fineOffsetMs, visualWindowEndMs) - seg.start) / subMs);

      for (let i = firstIndex; i <= lastIndex; i++) {
        const beatServerMs = seg.start + i * subMs;
        if (beatServerMs >= end - 0.5) break;

        const mainBeat = Math.floor(i / subPerBeat);
        const isSubdivision = i % subPerBeat !== 0;
        const isCountIn = mainBeat < seg.countInBeats;
        if (isCountIn && isSubdivision) continue; // Count-in clicks quarter notes only

        const beatInBar = mainBeat % numerator;
        let accentLevel: number;
        if (isCountIn) {
          accentLevel = beatInBar === 0 ? 2 : 1;
        } else if (isSubdivision) {
          accentLevel = (seg.accentPattern[beatInBar] ?? 1) === 0 ? 0 : 1;
        } else {
          accentLevel = seg.accentPattern[beatInBar] ?? (beatInBar === 0 ? 2 : 1);
        }

        const key = `${seg.start}_${seg.bpm}_${subPerBeat}_${i}`;

        // Audio (sent early by the personal fine offset)
        const audioServerMs = beatServerMs - fineOffsetMs;
        if (
          audioOk &&
          audioServerMs <= audioWindowEndMs &&
          audioServerMs >= serverNow - 20 &&
          !this.scheduledAudioBeats.has(key)
        ) {
          this.scheduledAudioBeats.add(key);
          // Queued even while muted: mute is a gain, so unmuting is heard on the very next click
          if (accentLevel > 0) {
            const playTime = this.serverToAudioTime(audioServerMs);
            // Never bunch missed beats into immediate clicks after a stall.
            if (playTime >= audioNow + 0.003) {
              const spoke = isCountIn && this.playVoiceNumber(playTime, beatInBar + 1, key);
              if (!spoke) {
                this.playSynthesizedClick(playTime, accentLevel, isSubdivision && !isCountIn, key, isCountIn ? 'drumstick' : undefined);
              }
            }
          }
        }

        // Visual flash on the true shared beat (unaffected by the personal audio offset)
        if (beatServerMs <= visualWindowEndMs && beatServerMs >= serverNow - 20 && !this.visualTimers.has(key)) {
          const delay = Math.max(0, beatServerMs - serverNow);
          const info: BeatInfo = {
            beatIndex: beatInBar,
            isAccent: accentLevel === 2,
            isSubdivision,
            isCountIn,
            countInBeatsLeft: isCountIn ? seg.countInBeats - mainBeat - 1 : 0,
          };
          const id = window.setTimeout(() => {
            if (!this.isRunning) return;
            this.beatCallbacks.forEach((cb) => cb(info));
          }, delay);
          this.visualTimers.set(key, { at: monotonicNowMs() + delay, id });
        }
      }
    }

    if (audioOk) {
      this.scheduledWithOffset = this.audioClockOffset;
      this.pruneBookkeeping(audioNow);
    }
  }

  /** Detect a stopped hardware clock even when Safari still reports 'running'. */
  private checkAudioClock(ctx: AudioContext): boolean {
    const now = monotonicNowMs();
    const previous = this.lastAudioSample;
    if (!previous || ctx.currentTime !== previous.time) {
      this.lastAudioSample = { time: ctx.currentTime, advancedAt: now };
      if (this.clockStalled) {
        this.clockStalled = false;
        this.resetAudioClock();
        this.stateListeners.forEach(l => l('running'));
      }
      return true;
    }
    if (now - previous.advancedAt < 250) return true;
    if (!this.clockStalled) {
      this.clockStalled = true;
      this.cancelFutureVoices(true);
      this.scheduledAudioBeats.clear();
      this.resetAudioClock();
      this.stateListeners.forEach(l => l('suspended'));
    }
    return false;
  }

  private pruneBookkeeping(audioNow: number) {
    if (this.pendingVoices.length > 64) {
      this.pendingVoices = this.pendingVoices.filter((v) => v.time > audioNow - 0.25);
    }
    if (this.scheduledAudioBeats.size > 600) {
      const live = new Set(this.pendingVoices.map((v) => v.key));
      // Keep keys of voices still pending so they are never scheduled twice
      for (const key of this.scheduledAudioBeats) {
        if (!live.has(key)) this.scheduledAudioBeats.delete(key);
        if (this.scheduledAudioBeats.size <= 300) break;
      }
    }
    if (this.visualTimers.size > 64) {
      const nowMs = monotonicNowMs();
      for (const [key, timer] of this.visualTimers) {
        if (timer.at < nowMs - 1000) this.visualTimers.delete(key);
      }
    }
  }

  /**
   * Punchy clicks designed to cut through acoustic drums and loud amps.
   * Feeds into the master DSP chain (Rumble HPF -> Presence Peak -> Digital Boost -> Tanh Clipper -> Limiter -> Output).
   */
  public playSynthesizedClick(time: number, accentLevel: number, isSubdivision: boolean, key?: string, presetOverride?: SoundPreset) {
    const ctx = this.getAudioContext();

    if (ctx.state !== 'running') {
      return;
    }

    const masterInput = this.getMasterInputNode();

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(1, time); // Volume lives on the shared input node
    voiceGain.connect(masterInput);

    if (key) {
      this.pendingVoices.push({
        time,
        key,
        cancel: () => {
          try {
            voiceGain.gain.cancelScheduledValues(0);
            voiceGain.gain.setValueAtTime(0, ctx.currentTime);
            voiceGain.disconnect();
          } catch {}
        },
      });
    }

    switch (presetOverride ?? this.soundPreset) {
      case 'digital': {
        // Boss DB-90 / Tama Rhythm Watch style piercing click in the 2.7-3.4 kHz sensitivity zone
        const oscSine = ctx.createOscillator();
        const oscHarmonic = ctx.createOscillator();
        const clickGain = ctx.createGain();

        const baseFreq = accentLevel === 2 ? 3400 : isSubdivision ? 1800 : 2650;
        oscSine.type = 'sine';
        oscSine.frequency.setValueAtTime(baseFreq, time);

        // Odd harmonics (square wave) to cut through cymbals
        oscHarmonic.type = 'square';
        oscHarmonic.frequency.setValueAtTime(baseFreq, time);

        const peakGain = accentLevel === 2 ? 1.7 : isSubdivision ? 0.75 : 1.35;
        clickGain.gain.setValueAtTime(peakGain, time);
        clickGain.gain.exponentialRampToValueAtTime(0.0001, time + (accentLevel === 2 ? 0.055 : 0.038));

        const harmGain = ctx.createGain();
        harmGain.gain.setValueAtTime(0.4, time);

        oscSine.connect(clickGain);
        oscHarmonic.connect(harmGain);
        harmGain.connect(clickGain);
        clickGain.connect(voiceGain);

        oscSine.start(time);
        oscSine.stop(time + 0.065);
        oscHarmonic.start(time);
        oscHarmonic.stop(time + 0.065);
        break;
      }

      case 'woodblock': {
        // Resonant wood block with a high-frequency transient
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        const freq = accentLevel === 2 ? 1750 : isSubdivision ? 950 : 1300;
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, time);
        osc.frequency.exponentialRampToValueAtTime(220, time + 0.045);

        const peakGain = accentLevel === 2 ? 1.6 : isSubdivision ? 0.65 : 1.3;
        gain.gain.setValueAtTime(peakGain, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);

        const clickOsc = ctx.createOscillator();
        const clickTransientGain = ctx.createGain();
        clickOsc.type = 'triangle';
        clickOsc.frequency.setValueAtTime(3600, time);
        clickOsc.frequency.exponentialRampToValueAtTime(450, time + 0.009);

        clickTransientGain.gain.setValueAtTime(peakGain * 1.35, time);
        clickTransientGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.012);

        osc.connect(gain);
        gain.connect(voiceGain);
        clickOsc.connect(clickTransientGain);
        clickTransientGain.connect(voiceGain);

        osc.start(time);
        osc.stop(time + 0.06);
        clickOsc.start(time);
        clickOsc.stop(time + 0.02);
        break;
      }

      case 'drumstick': {
        // Cross-stick / drumsticks count-off
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();

        const freq = accentLevel === 2 ? 2300 : isSubdivision ? 1150 : 1700;
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, time);
        osc.frequency.exponentialRampToValueAtTime(300, time + 0.024);

        const peakGain = accentLevel === 2 ? 1.7 : isSubdivision ? 0.7 : 1.35;
        oscGain.gain.setValueAtTime(peakGain, time);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.032);

        const snapOsc = ctx.createOscillator();
        const snapGain = ctx.createGain();
        snapOsc.type = 'square';
        snapOsc.frequency.setValueAtTime(4400, time);
        snapOsc.frequency.exponentialRampToValueAtTime(900, time + 0.007);
        snapGain.gain.setValueAtTime(peakGain * 0.85, time);
        snapGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.01);

        osc.connect(oscGain);
        oscGain.connect(voiceGain);
        snapOsc.connect(snapGain);
        snapGain.connect(voiceGain);

        osc.start(time);
        osc.stop(time + 0.045);
        snapOsc.start(time);
        snapOsc.stop(time + 0.018);
        break;
      }

      case 'cowbell': {
        // 808-style cowbell
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        const bandpass = ctx.createBiquadFilter();

        const baseFreq = accentLevel === 2 ? 980 : isSubdivision ? 620 : 820;
        osc1.type = 'square';
        osc2.type = 'square';
        osc1.frequency.setValueAtTime(baseFreq, time);
        osc2.frequency.setValueAtTime(baseFreq * 1.48, time);

        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(baseFreq * 1.3, time);
        bandpass.Q.setValueAtTime(4.0, time);

        const peakGain = accentLevel === 2 ? 1.5 : isSubdivision ? 0.6 : 1.2;
        gain.gain.setValueAtTime(peakGain, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.09);

        osc1.connect(bandpass);
        osc2.connect(bandpass);
        bandpass.connect(gain);
        gain.connect(voiceGain);

        osc1.start(time);
        osc2.start(time);
        osc1.stop(time + 0.1);
        osc2.stop(time + 0.1);
        break;
      }

      case 'synth':
      default: {
        // Sawtooth pulse with resonant filter snap
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filter = ctx.createBiquadFilter();

        const freq = accentLevel === 2 ? 1250 : isSubdivision ? 460 : 920;
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, time);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(accentLevel === 2 ? 5200 : 3400, time);
        filter.frequency.exponentialRampToValueAtTime(300, time + 0.05);
        filter.Q.setValueAtTime(5, time);

        const peakGain = accentLevel === 2 ? 1.5 : isSubdivision ? 0.55 : 1.2;
        gain.gain.setValueAtTime(peakGain, time);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.075);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(voiceGain);

        osc.start(time);
        osc.stop(time + 0.085);
        break;
      }
    }
  }
}

export const audioEngine = new AudioEngine();

// Diagnostics hook used by the browser test suite (and handy when debugging on a real phone)
if (typeof window !== 'undefined') {
  (window as unknown as { __diag?: () => unknown }).__diag = () => audioEngine.getDiagnostics();
}
