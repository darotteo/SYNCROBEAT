import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, AlertTriangle } from 'lucide-react';
import { audioEngine } from '../utils/audioEngine';
import { detectPitch, describeNote, nearestString, minBufferLength, TUNINGS, NoteReading, TunerString } from '../utils/pitchDetect';
import { Button, Card, SectionLabel, Segmented, cx } from './ui';

type InstrumentKey = keyof typeof TUNINGS | 'cromatico';

const INSTRUMENT_OPTIONS: { value: InstrumentKey; label: string }[] = [
  { value: 'guitarra', label: 'Guitarra' },
  { value: 'bajo', label: 'Bajo' },
  { value: 'ukelele', label: 'Ukelele' },
  { value: 'cromatico', label: 'Cromático' },
];

/** Within this many cents the note counts as in tune. Most tuners use five. */
const IN_TUNE_CENTS = 5;
/** Needle travel, in cents either side of centre. */
const DIAL_RANGE = 50;
/** Readings decay rather than vanish, so the note does not flash away between plucks. */
const HOLD_MS = 1200;
/**
 * Time between readings. A timer rather than requestAnimationFrame: detection costs a few million
 * operations each pass, so running it once per frame burns battery for no extra precision, and rAF
 * stops being delivered whenever the page is not being painted.
 */
const READ_INTERVAL_MS = 40;

interface TunerPanelProps {
  /** The click bleeds into the microphone and the tuner would read it instead of the string. */
  isPlaying: boolean;
}

export const TunerPanel: React.FC<TunerPanelProps> = ({ isPlaying }) => {
  const [instrument, setInstrument] = useState<InstrumentKey>('guitarra');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<NoteReading | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const nodesRef = useRef<{ source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null>(null);
  const smoothedRef = useRef<number | null>(null);
  const lastHeardRef = useRef(0);

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    nodesRef.current?.source.disconnect();
    nodesRef.current?.analyser.disconnect();
    nodesRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    smoothedRef.current = null;
    setListening(false);
    setNote(null);
  }, []);

  // Releasing the microphone when the panel closes matters: browsers keep showing the recording
  // indicator, and on a phone an open input can keep the radio and the mic warm.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // The browser's voice processing fights a sustained note: it ducks and re-gains it
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;

      audioEngine.unlockAudio();
      const ctx = audioEngine.getAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      // Deliberately not connected to the destination: that would feed the room back on itself
      analyser.fftSize = 8192;
      source.connect(analyser);
      nodesRef.current = { source, analyser };

      const buffer = new Float32Array(analyser.fftSize);
      const needed = minBufferLength(ctx.sampleRate);
      if (analyser.fftSize < needed) {
        setError('Este dispositivo no entrega suficiente audio para afinar las cuerdas graves.');
        stop();
        return;
      }

      const read = () => {
        // Nothing to show while the app is hidden, and the work is far from free
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        analyser.getFloatTimeDomainData(buffer);
        const reading = detectPitch(buffer, ctx.sampleRate);
        const now = performance.now();
        if (reading) {
          // Smoothed towards the new reading: the needle settles instead of twitching
          const previous = smoothedRef.current;
          const blended = previous === null ? reading.hz : previous * 0.7 + reading.hz * 0.3;
          smoothedRef.current = blended;
          lastHeardRef.current = now;
          setNote(describeNote({ hz: blended, clarity: reading.clarity }));
        } else if (now - lastHeardRef.current > HOLD_MS) {
          smoothedRef.current = null;
          setNote(null);
        }
      };
      setListening(true);
      read();
      timerRef.current = window.setInterval(read, READ_INTERVAL_MS);
    } catch (err) {
      const name = (err as DOMException)?.name;
      setError(
        name === 'NotAllowedError'
          ? 'No diste permiso al micrófono. Habilitalo para este sitio y probá de nuevo.'
          : name === 'NotFoundError'
          ? 'No encontramos un micrófono en este dispositivo.'
          : 'No se pudo abrir el micrófono.'
      );
      stop();
    }
  }, [stop]);

  const strings: TunerString[] = instrument === 'cromatico' ? [] : TUNINGS[instrument];
  const target = note && strings.length ? nearestString(note.hz, strings) : null;
  const inTune = note !== null && Math.abs(note.cents) <= IN_TUNE_CENTS;
  const needlePercent = note ? 50 + (Math.max(-DIAL_RANGE, Math.min(DIAL_RANGE, note.cents)) / DIAL_RANGE) * 50 : 50;

  return (
    <Card className="flex flex-col gap-4">
      <SectionLabel
        right={
          <Button size="sm" variant={listening ? 'secondary' : 'primary'} onClick={listening ? stop : start}>
            {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            {listening ? 'Parar' : 'Afinar'}
          </Button>
        }
      >
        Afinador
      </SectionLabel>

      <Segmented value={instrument} options={INSTRUMENT_OPTIONS} onChange={setInstrument} size="sm" />

      <div className="flex flex-col items-center gap-3 py-2">
        <div className="flex items-baseline gap-1 h-16">
          <span
            className={cx(
              'text-5xl font-light tabular-nums transition-colors',
              !note ? 'text-neutral-700' : inTune ? 'text-emerald-400' : 'text-white'
            )}
          >
            {note ? note.name : '—'}
          </span>
          {note && <span className="text-lg text-neutral-500">{note.octave}</span>}
        </div>

        {/* Cents dial */}
        <div className="w-full max-w-sm">
          <div className="relative h-10 rounded-2xl bg-surface-2 overflow-hidden">
            <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-neutral-600" />
            <div
              className={cx(
                'absolute inset-y-0 left-1/2 -translate-x-1/2 rounded-full transition-colors',
                inTune ? 'bg-emerald-400/15' : 'bg-transparent'
              )}
              style={{ width: `${(IN_TUNE_CENTS / DIAL_RANGE) * 100}%` }}
            />
            {note && (
              <div
                className={cx(
                  'absolute inset-y-1 w-1 rounded-full transition-all duration-75',
                  inTune ? 'bg-emerald-400' : 'bg-brand'
                )}
                style={{ left: `calc(${needlePercent}% - 2px)` }}
              />
            )}
          </div>
          <div className="flex justify-between text-[10px] text-neutral-600 mt-1 tabular-nums">
            <span>−50</span>
            <span>bemol ← → sostenido</span>
            <span>+50</span>
          </div>
        </div>

        <div className="text-xs text-neutral-500 tabular-nums h-4">
          {note ? (
            <>
              {note.hz.toFixed(1)} Hz · {note.cents > 0 ? `+${note.cents}` : note.cents} cents
              {target && <span className="text-neutral-600"> · cuerda {target.label}</span>}
            </>
          ) : listening ? (
            'Tocá una cuerda sola.'
          ) : (
            'Necesita permiso del micrófono.'
          )}
        </div>
      </div>

      {listening && isPlaying && (
        <p className="flex items-start gap-2 text-xs text-amber-300/80">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          El metrónomo está sonando y el micrófono lo escucha. Pará el click para afinar.
        </p>
      )}

      {error && <p className="text-xs text-rose-300">{error}</p>}

      <p className="text-[11px] text-neutral-600 leading-relaxed">
        El audio del micrófono se procesa en el teléfono y no sale de él: no se graba ni se envía a la sala.
      </p>
    </Card>
  );
};
