import React, { useEffect, useRef, useState } from 'react';
import { LockKeyhole, UnlockKeyhole, Minus, Plus, Check } from 'lucide-react';
import { Button, cx } from './ui';

interface Props {
  value: number;
  onChange: (value: number) => void;
  active?: boolean;
}

const clamp = (value: number) => Math.max(-150, Math.min(350, Math.round(value)));
const display = (value: number) => `${value > 0 ? '+' : ''}${value} ms`;

/**
 * Personal latency offset, locked by default so it is not changed by accident mid-song.
 * While unlocked every change is applied live (so it can be tuned by ear against the band);
 * "Cancelar" restores the value it had before unlocking.
 */
export function LatencyControl({ value, onChange, active = true }: Props) {
  const [original, setOriginal] = useState<number | null>(null);
  const editing = original !== null;
  const originalRef = useRef<number | null>(null);
  originalRef.current = original;

  const cancel = () => {
    if (originalRef.current !== null) onChange(originalRef.current);
    setOriginal(null);
  };

  useEffect(() => {
    if (!active && originalRef.current !== null) cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    const lock = () => {
      if (document.visibilityState === 'hidden' && originalRef.current !== null) cancel();
    };
    document.addEventListener('visibilitychange', lock);
    return () => document.removeEventListener('visibilitychange', lock);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (next: number) => onChange(clamp(next));

  return (
    <section aria-label="Compensación de latencia" className={cx('brand-panel rounded-3xl p-5', editing ? 'border-accent/40' : 'border-white/10')}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-white">Compensación de latencia</h2>
          <p className="text-xs text-neutral-400 mt-1">Solo en este dispositivo</p>
        </div>
        <span className="text-2xl text-accent font-light tabular-nums whitespace-nowrap">{display(value)}</span>
      </div>
      {!editing ? (
        <div className="flex items-center justify-between gap-3 mt-4">
          <span className="inline-flex items-center gap-1.5 text-xs text-neutral-400"><LockKeyhole className="w-3.5 h-3.5" /> Ajuste bloqueado</span>
          <Button size="sm" onClick={() => setOriginal(value)}><UnlockKeyhole className="w-4 h-4" /> Desbloquear ajuste</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4 mt-4">
          <p className="text-xs text-neutral-300 leading-relaxed">
            Con el metrónomo andando: si tu click llega tarde, sumá milisegundos; si llega antes, restá. El cambio se escucha al instante.
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button size="md" aria-label="Restar 10 ms" onClick={() => set(value - 10)}>−10</Button>
            <Button size="md" aria-label="Restar 1 ms" onClick={() => set(value - 1)}><Minus className="w-4 h-4" /></Button>
            <output aria-label="Compensación actual" className="flex-1 text-center text-xl tabular-nums text-white whitespace-nowrap">{display(value)}</output>
            <Button size="md" aria-label="Sumar 1 ms" onClick={() => set(value + 1)}><Plus className="w-4 h-4" /></Button>
            <Button size="md" aria-label="Sumar 10 ms" onClick={() => set(value + 10)}>+10</Button>
          </div>
          <input type="range" min={-150} max={350} step={1} value={value} onChange={(e) => set(Number(e.target.value))} aria-label="Ajustar compensación de latencia" className="range" />
          <div className="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={cancel}>Cancelar</Button>
            <Button size="sm" variant="primary" onClick={() => setOriginal(null)}><Check className="w-4 h-4" /> Listo, bloquear</Button>
          </div>
        </div>
      )}
    </section>
  );
}
