import React from 'react';
import { TimeSignature, Subdivision, COMMON_SIGNATURES } from '../types/metronome';
import { Card, SectionLabel, Segmented, cx } from './ui';

interface SignatureControlsProps {
  timeSignature: TimeSignature;
  subdivision: Subdivision;
  onSetTimeSignature: (ts: TimeSignature) => void;
  onSetSubdivision: (sub: Subdivision) => void;
}

export { COMMON_SIGNATURES };

export const SUBDIVISIONS: { id: Subdivision; label: string; name: string }[] = [
  { id: '1', label: '♩', name: 'Negras' },
  { id: '2', label: '♫', name: 'Corcheas' },
  { id: '3', label: '3', name: 'Tresillos' },
  { id: '4', label: '♬', name: 'Semicorcheas' },
];

const SignatureControlsComponent: React.FC<SignatureControlsProps> = ({
  timeSignature,
  subdivision,
  onSetTimeSignature,
  onSetSubdivision,
}) => {
  return (
    <Card className="flex flex-col gap-6">
      <div>
        <SectionLabel>Compás</SectionLabel>
        <div className="grid grid-cols-4 sm:grid-cols-7 gap-2">
          {COMMON_SIGNATURES.map((sig) => {
            const selected = timeSignature.numerator === sig.numerator && timeSignature.denominator === sig.denominator;
            return (
              <button
                key={`${sig.numerator}/${sig.denominator}`}
                type="button"
                aria-pressed={selected}
                onClick={() => onSetTimeSignature(sig)}
                className={cx(
                  'h-11 rounded-2xl text-sm tabular-nums transition-colors active:scale-95',
                  selected ? 'bg-white text-black font-medium' : 'bg-surface-2 text-neutral-400 hover:text-white'
                )}
              >
                {sig.numerator}/{sig.denominator}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <SectionLabel right={<span className="text-xs text-neutral-500">{SUBDIVISIONS.find((s) => s.id === subdivision)?.name}</span>}>
          Subdivisión
        </SectionLabel>
        <Segmented
          value={subdivision}
          onChange={onSetSubdivision}
          options={SUBDIVISIONS.map((s) => ({ value: s.id, label: <span className="text-lg">{s.label}</span>, title: s.name }))}
        />
      </div>
    </Card>
  );
};

export const SignatureControls = React.memo(SignatureControlsComponent);
