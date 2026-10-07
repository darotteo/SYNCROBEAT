import { InstrumentType } from '../types/metronome';

export const INSTRUMENT_METADATA: Record<InstrumentType, { label: string; shortLabel: string; emoji: string }> = {
  drums: { label: 'Batería / Percusión', shortLabel: 'Batería', emoji: '🥁' },
  guitar: { label: 'Guitarra', shortLabel: 'Guitarra', emoji: '🎸' },
  bass: { label: 'Bajo', shortLabel: 'Bajo', emoji: '⚡' },
  keys: { label: 'Teclados', shortLabel: 'Teclado', emoji: '🎹' },
  vocals: { label: 'Voz', shortLabel: 'Voz', emoji: '🎙️' },
  horns: { label: 'Vientos', shortLabel: 'Vientos', emoji: '🎷' },
  strings: { label: 'Cuerdas', shortLabel: 'Cuerdas', emoji: '🎻' },
  other: { label: 'Otro', shortLabel: 'Otro', emoji: '🎛️' },
};
