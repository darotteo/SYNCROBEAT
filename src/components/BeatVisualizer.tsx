import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { TimeSignature } from '../types/metronome';
import { audioEngine } from '../utils/audioEngine';
import { Card, IconButton, cx } from './ui';

interface BeatVisualizerProps {
  isPlaying: boolean;
  timeSignature: TimeSignature;
  accentPattern: number[];
  canEdit: boolean;
  onToggleAccent: (index: number) => void;
  fullScreenFlash: boolean;
  onToggleFullScreenFlash: () => void;
}

interface BeatView {
  beat: number;
  isAccent: boolean;
  isCountIn: boolean;
  countInLeft: number;
  tick: number;
}

const IDLE: BeatView = { beat: -1, isAccent: false, isCountIn: false, countInLeft: 0, tick: 0 };

export const BeatVisualizer: React.FC<BeatVisualizerProps> = ({
  isPlaying,
  timeSignature,
  accentPattern,
  canEdit,
  onToggleAccent,
  fullScreenFlash,
  onToggleFullScreenFlash,
}) => {
  // Beat state lives here so 60fps updates never re-render the rest of the app
  const [view, setView] = useState<BeatView>(IDLE);

  useEffect(() => {
    return audioEngine.onBeat((info) => {
      if (info.isSubdivision) return;
      setView((prev) => ({
        beat: info.beatIndex,
        isAccent: info.isAccent,
        isCountIn: info.isCountIn,
        countInLeft: info.countInBeatsLeft,
        tick: prev.tick + 1,
      }));
    });
  }, []);

  useEffect(() => {
    if (!isPlaying) setView(IDLE);
  }, [isPlaying]);

  const live = isPlaying && view.beat >= 0;
  const status = !isPlaying
    ? 'Detenido'
    : view.isCountIn
    ? `Cuenta · ${view.countInLeft + 1}`
    : live
    ? `Tiempo ${view.beat + 1}`
    : 'Arrancando…';

  return (
    <>
      {live && fullScreenFlash && (
        <div
          key={view.tick}
          className={cx(
            'pointer-events-none fixed inset-0 z-40 animate-beat-flash',
            view.isCountIn ? 'bg-amber-400/30' : view.isAccent ? 'bg-accent/40' : 'bg-white/20'
          )}
        />
      )}

      <Card>
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex items-baseline gap-3">
            <span className="font-sans font-light text-2xl text-white tabular-nums">
              {timeSignature.numerator}/{timeSignature.denominator}
            </span>
            <span
              className={cx(
                'text-sm tabular-nums',
                view.isCountIn && isPlaying ? 'text-amber-300' : isPlaying ? 'text-neutral-300' : 'text-neutral-500'
              )}
            >
              {status}
            </span>
          </div>
          <IconButton
            label={fullScreenFlash ? 'Desactivar flash de pantalla' : 'Flash en toda la pantalla'}
            active={fullScreenFlash}
            onClick={onToggleFullScreenFlash}
          >
            <Zap className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="flex gap-2 sm:gap-3">
          {Array.from({ length: timeSignature.numerator }).map((_, index) => {
            const level = accentPattern[index] ?? (index === 0 ? 2 : 1);
            const isCurrent = live && view.beat === index;

            return (
              <button
                key={index}
                type="button"
                disabled={!canEdit}
                onClick={() => onToggleAccent(index)}
                aria-label={`Tiempo ${index + 1}: ${level === 2 ? 'acentuado' : level === 1 ? 'normal' : 'en silencio'}`}
                className={cx(
                  'relative flex-1 min-w-0 rounded-2xl flex items-center justify-center transition-colors duration-75 select-none',
                  timeSignature.numerator > 8 ? 'h-14' : 'h-20 sm:h-24',
                  canEdit ? 'active:scale-95' : 'cursor-default',
                  isCurrent
                    ? view.isCountIn
                      ? 'bg-brand text-black shadow-lg shadow-brand/10'
                      : level === 2
                      ? 'bg-brand text-black shadow-lg shadow-brand/10'
                      : 'bg-brand text-black'
                    : level === 0
                    ? 'border border-dashed border-neutral-700 text-neutral-700'
                    : level === 2
                    ? 'bg-surface-3 text-white'
                    : 'bg-surface-2 text-neutral-500'
                )}
              >
                {level === 2 && !isCurrent && (
                  <span className="absolute top-2 left-1/2 -translate-x-1/2 w-4 h-1 rounded-full bg-accent" />
                )}
                <span className={cx('font-sans font-light tabular-nums', timeSignature.numerator > 8 ? 'text-xl' : 'text-3xl sm:text-4xl')}>
                  {index + 1}
                </span>
              </button>
            );
          })}
        </div>

        {canEdit && (
          <p className="mt-3 text-xs text-neutral-600">
            Tocá un tiempo para alternar acento, normal y silencio.
          </p>
        )}
      </Card>
    </>
  );
};
