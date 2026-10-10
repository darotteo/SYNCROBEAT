import React, { useState } from 'react';
import { Play, Square, SkipBack, SkipForward, Save } from 'lucide-react';
import { SongItem, MIN_BPM, MAX_BPM } from '../types/metronome';
import { Button, Card, IconButton, Segmented } from './ui';

interface TempoControlsProps {
  bpm: number;
  isPlaying: boolean;
  canControl: boolean;
  controllerName: string | null;
  onTogglePlay: () => void;
  onSetBpm: (bpm: number) => void;
  onAdjustBpm: (delta: number) => void;
  onTapTempo: () => void;
  countInBars: number;
  onSetCountInBars: (bars: number) => void;
  currentSong?: SongItem;
  currentIndex: number;
  setlistCount: number;
  onNextSong: () => void;
  onPrevSong: () => void;
  onSaveBpmToSong: () => void;
}

function getTempoMarking(bpm: number): string {
  if (bpm < 60) return 'Largo';
  if (bpm < 66) return 'Larghetto';
  if (bpm < 76) return 'Adagio';
  if (bpm < 108) return 'Andante';
  if (bpm < 120) return 'Moderato';
  if (bpm < 168) return 'Allegro';
  if (bpm < 200) return 'Vivace';
  return 'Presto';
}

const TempoControlsComponent: React.FC<TempoControlsProps> = ({
  bpm,
  isPlaying,
  canControl,
  controllerName,
  onTogglePlay,
  onSetBpm,
  onAdjustBpm,
  onTapTempo,
  countInBars,
  onSetCountInBars,
  currentSong,
  currentIndex,
  setlistCount,
  onNextSong,
  onPrevSong,
  onSaveBpmToSong,
}) => {
  // While dragging the slider only the final value is sent, so the band hears one clean change
  const [dragBpm, setDragBpm] = useState<number | null>(null);
  const shownBpm = dragBpm ?? bpm;

  const commitDrag = () => {
    if (dragBpm !== null) {
      onSetBpm(dragBpm);
      setDragBpm(null);
    }
  };

  return (
    <Card className="flex flex-col items-center">
      {/* Current song */}
      {setlistCount > 0 && (
        <div className="w-full flex items-center gap-2 mb-2">
          {canControl && (
            <IconButton label="Tema anterior" onClick={onPrevSong}>
              <SkipBack className="w-4 h-4" />
            </IconButton>
          )}
          <div className="flex-1 min-w-0 text-center">
            <div className="text-xs text-neutral-500 tabular-nums">
              {currentSong ? `Tema ${currentIndex + 1} de ${setlistCount}` : `${setlistCount} temas en el setlist`}
            </div>
            <div className="text-base text-white truncate">{currentSong ? currentSong.title : 'Ningún tema elegido'}</div>
          </div>
          {canControl && (
            <IconButton label="Tema siguiente" onClick={onNextSong}>
              <SkipForward className="w-4 h-4" />
            </IconButton>
          )}
        </div>
      )}

      {/* Tempo readout */}
      <div className="flex flex-col items-center select-none py-2">
        <span className="font-sans font-light text-[6.5rem] sm:text-[8rem] leading-none tracking-tight text-white tabular-nums">
          {shownBpm}
        </span>
        <span className="text-sm text-neutral-500 mt-1">
          BPM · {getTempoMarking(shownBpm)}
        </span>
        {canControl && currentSong && currentSong.bpm !== bpm && (
          <button
            type="button"
            onClick={onSaveBpmToSong}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-neutral-400 hover:text-white transition-colors"
          >
            <Save className="w-3.5 h-3.5" />
            Guardar {bpm} BPM en «{currentSong.title}» (era {currentSong.bpm})
          </button>
        )}
      </div>

      {canControl ? (
        <>
          <div className="w-full grid grid-cols-4 gap-2 mt-4">
            {[-5, -1, 1, 5].map((delta) => (
              <Button
                key={delta}
                size="md"
                onClick={() => onAdjustBpm(delta)}
                disabled={(delta < 0 && bpm <= MIN_BPM) || (delta > 0 && bpm >= MAX_BPM)}
                className="tabular-nums text-base"
                aria-label={`${delta > 0 ? 'Sumar' : 'Restar'} ${Math.abs(delta)} BPM`}
              >
                {delta > 0 ? `+${delta}` : `−${Math.abs(delta)}`}
              </Button>
            ))}
          </div>

          <input
            type="range"
            min={MIN_BPM}
            max={MAX_BPM}
            value={shownBpm}
            aria-label="Tempo"
            onChange={(e) => setDragBpm(Number(e.target.value))}
            onPointerUp={commitDrag}
            onTouchEnd={commitDrag}
            onKeyUp={commitDrag}
            onBlur={commitDrag}
            className="range mt-4"
          />

          <div className="w-full grid grid-cols-[1fr_2fr] gap-2 mt-4">
            <Button size="lg" onClick={onTapTempo} title="Tocá al ritmo para calcular el tempo (tecla T)">
              Tap
            </Button>
            <Button
              size="lg"
              variant={isPlaying ? 'secondary' : 'primary'}
              onClick={onTogglePlay}
              className={isPlaying ? 'ring-1 ring-white/20' : ''}
            >
              {isPlaying ? <Square className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
              {isPlaying ? 'Detener' : 'Iniciar'}
            </Button>
          </div>

          <div className="w-full mt-4">
            <Segmented
              size="sm"
              value={countInBars}
              onChange={onSetCountInBars}
              options={[
                { value: 0, label: 'Sin cuenta' },
                { value: 1, label: '1 compás', title: 'Cuenta previa de 1 compás' },
                { value: 2, label: '2 compases', title: 'Cuenta previa de 2 compases' },
              ]}
            />
          </div>

          <p className="hidden lg:block mt-4 text-xs text-neutral-600">
            Espacio: iniciar / detener · ↑ ↓: tempo · ← →: tema · T: tap · F: atril
          </p>
        </>
      ) : (
        <div className="mt-4 flex flex-col items-center gap-2 text-center">
          <span
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
              isPlaying ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-neutral-400'
            }`}
          >
            <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-accent animate-pulse' : 'bg-neutral-600'}`} />
            {isPlaying ? 'Sonando' : 'Detenido'}
          </span>
          <p className="text-xs text-neutral-500">
            {controllerName ? `${controllerName} dirige la sala y controla el tempo.` : 'Esperando a quien dirija la sala.'}
          </p>
        </div>
      )}
    </Card>
  );
};

export const TempoControls = React.memo(TempoControlsComponent);
