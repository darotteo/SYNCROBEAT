import React, { useEffect, useState } from 'react';
import { X, Play, Square, SkipBack, SkipForward } from 'lucide-react';
import { SongItem, TimeSignature } from '../types/metronome';
import { audioEngine } from '../utils/audioEngine';
import { cx } from './ui';

interface StageModeProps {
  open: boolean;
  onClose: () => void;
  isPlaying: boolean;
  bpm: number;
  timeSignature: TimeSignature;
  accentPattern: number[];
  currentSong?: SongItem;
  nextSong?: SongItem;
  currentIndex: number;
  setlistCount: number;
  canControl: boolean;
  controllerName: string | null;
  onTogglePlay: () => void;
  onNextSong: () => void;
  onPrevSong: () => void;
}

interface BeatView {
  beat: number;
  isAccent: boolean;
  isCountIn: boolean;
  countInLeft: number;
  tick: number;
}

const IDLE: BeatView = { beat: -1, isAccent: false, isCountIn: false, countInLeft: 0, tick: 0 };

/** Full-screen, high-contrast view for the music stand: readable from a few meters, big touch targets. */
export const StageMode: React.FC<StageModeProps> = ({
  open,
  onClose,
  isPlaying,
  bpm,
  timeSignature,
  accentPattern,
  currentSong,
  nextSong,
  currentIndex,
  setlistCount,
  canControl,
  controllerName,
  onTogglePlay,
  onNextSong,
  onPrevSong,
}) => {
  const [view, setView] = useState<BeatView>(IDLE);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  useEffect(() => {
    if (!isPlaying) setView(IDLE);
  }, [isPlaying]);

  // Real browser full screen where supported (not on iPhone, where the overlay already covers the page)
  useEffect(() => {
    if (!open) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    }
    const onFsChange = () => {
      if (!document.fullscreenElement) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
  }, [open, onClose]);

  if (!open) return null;

  const live = isPlaying && view.beat >= 0;
  const bigNumber = !isPlaying ? '–' : view.isCountIn ? String(view.countInLeft + 1) : live ? String(view.beat + 1) : '·';

  return (
    <div className="fixed inset-0 z-[60] bg-black text-white flex flex-col select-none pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      {live && (
        <div
          key={view.tick}
          className={cx(
            'pointer-events-none absolute inset-0 animate-beat-flash',
            view.isCountIn ? 'bg-amber-400/35' : view.isAccent ? 'bg-accent/45' : 'bg-white/15'
          )}
        />
      )}

      {/* Top: song */}
      <div className="relative flex items-start gap-4 px-5 pt-4">
        <div className="flex-1 min-w-0">
          {setlistCount > 0 && currentSong ? (
            <>
              <div className="text-sm text-neutral-500 tabular-nums">
                Tema {currentIndex + 1} de {setlistCount}
              </div>
              <div className="text-3xl sm:text-5xl font-light truncate">{currentSong.title}</div>
              {currentSong.notes && <div className="text-base sm:text-xl text-neutral-400 truncate mt-1">{currentSong.notes}</div>}
            </>
          ) : (
            <div className="text-xl text-neutral-500">Modo atril</div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Salir del modo atril"
          className="w-14 h-14 rounded-2xl bg-neutral-900 text-neutral-300 hover:text-white flex items-center justify-center shrink-0"
        >
          <X className="w-7 h-7" />
        </button>
      </div>

      {/* Center: beat + tempo */}
      <div className="relative flex-1 flex flex-col items-center justify-center min-h-0">
        <div
          className={cx(
            'font-sans font-light leading-none tabular-nums text-[38vh] sm:text-[45vh]',
            view.isCountIn && isPlaying ? 'text-amber-300' : live && view.isAccent ? 'text-accent' : 'text-white'
          )}
          aria-live="off"
        >
          {bigNumber}
        </div>

        <div className="flex gap-3 mt-2">
          {Array.from({ length: timeSignature.numerator }).map((_, i) => {
            const level = accentPattern[i] ?? (i === 0 ? 2 : 1);
            const isCurrent = live && view.beat === i;
            return (
              <span
                key={i}
                className={cx(
                  'w-5 h-5 sm:w-7 sm:h-7 rounded-full transition-colors duration-75',
                  isCurrent
                    ? 'bg-brand'
                    : level === 0
                    ? 'border-2 border-neutral-800'
                    : 'bg-neutral-800'
                )}
              />
            );
          })}
        </div>

        <div className="mt-6 text-4xl sm:text-6xl font-light tabular-nums">
          {bpm} <span className="text-neutral-500 text-2xl sm:text-3xl">BPM · {timeSignature.numerator}/{timeSignature.denominator}</span>
        </div>
        {nextSong && <div className="mt-3 text-lg sm:text-2xl text-neutral-500 truncate max-w-[90vw]">Sigue: {nextSong.title}</div>}
      </div>

      {/* Bottom: big controls */}
      {canControl ? (
        <div className="relative grid grid-cols-[1fr_1.6fr_1fr] gap-3 p-4">
          <button
            type="button"
            onClick={onPrevSong}
            disabled={setlistCount === 0}
            className="h-24 sm:h-28 rounded-3xl bg-neutral-900 hover:bg-neutral-800 disabled:opacity-30 flex items-center justify-center gap-2 text-lg"
          >
            <SkipBack className="w-8 h-8" />
            <span className="hidden sm:inline">Anterior</span>
          </button>
          <button
            type="button"
            onClick={onTogglePlay}
            className={cx(
              'h-24 sm:h-28 rounded-3xl flex items-center justify-center gap-3 text-2xl font-medium',
              isPlaying ? 'bg-neutral-800 text-white ring-2 ring-white/30' : 'brand-primary text-black'
            )}
          >
            {isPlaying ? <Square className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current" />}
            {isPlaying ? 'Detener' : 'Iniciar'}
          </button>
          <button
            type="button"
            onClick={onNextSong}
            disabled={setlistCount === 0}
            className="h-24 sm:h-28 rounded-3xl bg-neutral-900 hover:bg-neutral-800 disabled:opacity-30 flex items-center justify-center gap-2 text-lg"
          >
            <span className="hidden sm:inline">Siguiente</span>
            <SkipForward className="w-8 h-8" />
          </button>
        </div>
      ) : (
        <div className="relative p-6 text-center text-lg text-neutral-500">
          {controllerName ? `${controllerName} controla el tempo` : 'Esperando a quien dirija la sala'}
        </div>
      )}
    </div>
  );
};
