import React, { useEffect, useState } from 'react';
import { RefreshCw, Volume2, Check } from 'lucide-react';
import { SoundPreset } from '../types/metronome';
import { audioEngine, CountInSound } from '../utils/audioEngine';
import { Button, Modal, SectionLabel, Segmented, Toggle, cx } from './ui';
import { LatencyControl } from './LatencyControl';

interface LocalAudioSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  latencyMs: number;
  onRecalibrateClock: () => void;
  fineOffsetMs: number;
  onChangeOffset: (offset: number) => void;
  isMuted: boolean;
  onSetMuted: (muted: boolean) => void;
  keepScreenAwake: boolean;
  onToggleKeepScreenAwake: (value: boolean) => void;
  isOffline: boolean;
}

const SOUND_PRESETS: { id: SoundPreset; label: string; desc: string }[] = [
  { id: 'digital', label: 'Digital', desc: 'Agudo y penetrante, corta la batería' },
  { id: 'woodblock', label: 'Madera', desc: 'Clave seca, más natural' },
  { id: 'drumstick', label: 'Baqueta', desc: 'Golpe de palillo' },
  { id: 'cowbell', label: 'Cencerro', desc: 'Cowbell 808' },
  { id: 'synth', label: 'Sintetizador', desc: 'Pulso electrónico' },
];

const BOOST_LEVELS = [
  { value: 1.0, label: 'Normal' },
  { value: 2.0, label: 'Sala' },
  { value: 2.8, label: 'Fuerte' },
  { value: 3.5, label: 'Máximo' },
];

function closestBoost(level: number) {
  return BOOST_LEVELS.reduce((best, l) => (Math.abs(l.value - level) < Math.abs(best.value - level) ? l : best)).value;
}

export const LocalAudioSettingsModal: React.FC<LocalAudioSettingsModalProps> = ({
  isOpen,
  onClose,
  latencyMs,
  onRecalibrateClock,
  fineOffsetMs,
  onChangeOffset,
  isMuted,
  onSetMuted,
  keepScreenAwake,
  onToggleKeepScreenAwake,
  isOffline,
}) => {
  const [preset, setPreset] = useState<SoundPreset>(audioEngine.getSoundPreset());
  const [countInSound, setCountInSound] = useState<CountInSound>(audioEngine.getCountInSound());
  const [volume, setVolume] = useState(Math.round(audioEngine.getVolume() * 100));
  const [isStageBoost, setIsStageBoost] = useState(audioEngine.getStageBoost());
  const [boostLevel, setBoostLevel] = useState(closestBoost(audioEngine.getDigitalGainBoost()));
  const [deviceLatency, setDeviceLatency] = useState(audioEngine.getDetectedLatencyMs());
  const [diag, setDiag] = useState(() => audioEngine.getDiagnostics());
  const [recalibrated, setRecalibrated] = useState(false);

  // The detected output latency changes when headphones are plugged in or out
  useEffect(() => {
    if (!isOpen) return;
    audioEngine.getAudioContext();
    const refresh = () => {
      setDeviceLatency(audioEngine.getDetectedLatencyMs());
      setDiag(audioEngine.getDiagnostics());
    };
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, [isOpen]);

  const choosePreset = (id: SoundPreset) => {
    setPreset(id);
    audioEngine.setSoundPreset(id);
    audioEngine.previewClick();
  };

  const chooseCountIn = (sound: CountInSound) => {
    setCountInSound(sound);
    audioEngine.setCountInSound(sound);
    // Give the voice files a moment to load before the preview
    window.setTimeout(() => audioEngine.previewCountIn(1), sound === 'sticks' ? 0 : 250);
  };

  const changeVolume = (value: number) => {
    setVolume(value);
    audioEngine.setVolume(value / 100);
  };

  const toggleBoost = (on: boolean) => {
    setIsStageBoost(on);
    audioEngine.setStageBoost(on);
    audioEngine.playTestClick(true);
  };

  const chooseBoost = (level: number) => {
    setBoostLevel(level);
    audioEngine.setDigitalGainBoost(level);
    if (!isStageBoost) {
      setIsStageBoost(true);
      audioEngine.setStageBoost(true);
    }
    audioEngine.playTestClick(true);
  };

  const handleRecalibrate = () => {
    onRecalibrateClock();
    setRecalibrated(true);
    window.setTimeout(() => setRecalibrated(false), 2000);
  };

  return (
    <Modal open={isOpen} onClose={onClose} title="Ajustes de audio" subtitle="Solo afectan a este dispositivo">
      {/* Sound */}
      <section>
        <SectionLabel>Sonido del click</SectionLabel>
        <div className="flex flex-col gap-1">
          {SOUND_PRESETS.map((p) => {
            const selected = preset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => choosePreset(p.id)}
                className={cx(
                  'flex items-center gap-3 px-4 h-14 rounded-2xl text-left transition-colors',
                  selected ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                )}
              >
                <span
                  className={cx(
                    'w-5 h-5 rounded-full flex items-center justify-center shrink-0',
                    selected ? 'bg-white text-black' : 'border border-neutral-700'
                  )}
                >
                  {selected && <Check className="w-3 h-3" />}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-white">{p.label}</span>
                  <span className="block text-xs text-neutral-500 truncate">{p.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Count-in */}
      <section>
        <SectionLabel>Cuenta previa</SectionLabel>
        <Segmented
          size="sm"
          value={countInSound}
          onChange={chooseCountIn}
          options={[
            { value: 'sticks', label: 'Baquetas' },
            { value: 'voice-es', label: 'Voz (español)' },
            { value: 'voice-en', label: 'Voz (inglés)' },
          ]}
        />
        <p className="text-xs text-neutral-600 mt-2">Así suena la cuenta antes de arrancar en este dispositivo: «1, 2, 3, 4».</p>
      </section>

      {/* Volume */}
      <section>
        <SectionLabel right={<span className="text-xs text-neutral-400 tabular-nums">{isMuted ? 'Silenciado' : `${volume}%`}</span>}>
          Volumen
        </SectionLabel>
        <div className="flex items-center gap-4">
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            disabled={isMuted}
            aria-label="Volumen del click"
            onChange={(e) => changeVolume(Number(e.target.value))}
            className="range flex-1"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-neutral-500">Silenciar</span>
            <Toggle checked={isMuted} onChange={onSetMuted} label="Silenciar el click en este dispositivo" />
          </div>
        </div>
      </section>

      {/* Boost */}
      <section>
        <SectionLabel right={<Toggle checked={isStageBoost} onChange={toggleBoost} label="Refuerzo de volumen" />}>
          Refuerzo para tocar fuerte
        </SectionLabel>
        <Segmented
          size="sm"
          value={boostLevel}
          onChange={chooseBoost}
          disabled={!isStageBoost}
          options={BOOST_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
        />
        <p className="text-xs text-neutral-600 mt-2">Sube el volumen percibido con compresión, útil en sala con batería y amplis.</p>
      </section>

      {/* Sync */}
      <section className="flex flex-col gap-4">
        <SectionLabel className="mb-0">Sincronización</SectionLabel>

        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-surface-2">
          <div className="min-w-0">
            <div className="text-sm text-white">Latencia del dispositivo</div>
            <div className="text-xs text-neutral-500">Detectada y compensada automáticamente</div>
          </div>
          <span className="text-lg font-light tabular-nums text-white">{deviceLatency} ms</span>
        </div>

        <LatencyControl value={fineOffsetMs} onChange={onChangeOffset} active={isOpen} />

        {!isOffline && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-2xl bg-surface-2">
            <div className="min-w-0">
              <div className="text-sm text-white">Red</div>
              <div className="text-xs text-neutral-500 tabular-nums">{latencyMs} ms hasta el servidor</div>
            </div>
            <Button size="sm" className="bg-surface-3" onClick={handleRecalibrate}>
              {recalibrated ? <Check className="w-4 h-4" /> : <RefreshCw className="w-4 h-4" />}
              {recalibrated ? 'Listo' : 'Resincronizar'}
            </Button>
          </div>
        )}

        <details className="px-4 py-3 rounded-2xl bg-surface-2">
          <summary className="cursor-pointer text-sm text-white">Diagnóstico técnico</summary>
          <p className="text-xs text-neutral-500 mt-2">
            Si el click se corre, dejá el metrónomo andando un minuto, abrí esto y mandá una captura.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 mt-3 text-xs tabular-nums">
            <dt className="text-neutral-500">Audio</dt>
            <dd className="text-neutral-200">{diag.state}{diag.isRunning ? ' · sonando' : ''}</dd>
            <dt className="text-neutral-500">Frecuencia</dt>
            <dd className="text-neutral-200">{diag.sampleRate ? `${diag.sampleRate} Hz` : '—'}</dd>
            <dt className="text-neutral-500">Latencia base / salida</dt>
            <dd className="text-neutral-200">{diag.baseLatencyMs} ms / {diag.outputLatencyMs} ms</dd>
            <dt className="text-neutral-500">Reloj de salida</dt>
            <dd className="text-neutral-200">{diag.clockSource === 'output' ? 'medido por el sistema' : 'estimado'} · {diag.detectedLatencyMs} ms</dd>
            <dt className="text-neutral-500">Deriva del reloj</dt>
            <dd className="text-neutral-200">{diag.driftPpm === null ? 'midiendo… (dejalo sonar)' : `${diag.driftPpm} ppm`}</dd>
            <dt className="text-neutral-500">Desfase con la sala</dt>
            <dd className="text-neutral-200">{diag.serverOffsetMs} ms</dd>
            <dt className="text-neutral-500">Ajuste fino</dt>
            <dd className="text-neutral-200">{fineOffsetMs} ms</dd>
            <dt className="text-neutral-500">Dispositivo</dt>
            <dd className="text-neutral-400 break-all">{navigator.userAgent}</dd>
          </dl>
        </details>
      </section>

      {/* Screen */}
      <section className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm text-white">Mantener pantalla encendida</div>
          <div className="text-xs text-neutral-500">Evita que se apague mientras estás en la sala</div>
        </div>
        <Toggle checked={keepScreenAwake} onChange={onToggleKeepScreenAwake} label="Mantener pantalla encendida" />
      </section>

      <Button size="md" onClick={() => audioEngine.previewClick()} className="w-full">
        <Volume2 className="w-4 h-4" />
        Probar sonido
      </Button>
    </Modal>
  );
};
