import React, { useState } from 'react';
import { Send } from 'lucide-react';
import { RehearsalCue } from '../types/metronome';
import { Card, IconButton, SectionLabel, cx, inputClass } from './ui';

interface RehearsalCuesProps {
  recentCues: RehearsalCue[];
  onSendCue: (text: string, type?: RehearsalCue['type']) => void;
}

const QUICK_CUES: { text: string; type: RehearsalCue['type'] }[] = [
  { text: 'Cuento 4 y entramos', type: 'count-in' },
  { text: 'Desde el principio', type: 'section' },
  { text: 'Vamos al estribillo', type: 'section' },
  { text: 'Atentos al solo', type: 'section' },
  { text: 'Corte', type: 'stop' },
  { text: 'Una vez más', type: 'custom' },
  { text: 'Más suave', type: 'custom' },
  { text: 'Más fuerte', type: 'custom' },
  { text: 'Final', type: 'stop' },
];

export const RehearsalCues: React.FC<RehearsalCuesProps> = ({ recentCues, onSendCue }) => {
  const [customText, setCustomText] = useState('');

  const handleSendCustom = (e: React.FormEvent) => {
    e.preventDefault();
    if (customText.trim()) {
      onSendCue(customText.trim(), 'custom');
      setCustomText('');
    }
  };

  return (
    <Card className="flex flex-col gap-5">
      <div>
        <SectionLabel>Aviso rápido a toda la banda</SectionLabel>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {QUICK_CUES.map((cue) => (
            <button
              key={cue.text}
              type="button"
              onClick={() => onSendCue(cue.text, cue.type)}
              className={cx(
                'h-11 px-3 rounded-2xl text-sm text-left truncate transition-colors active:scale-[0.97]',
                cue.type === 'stop' ? 'bg-rose-500/10 text-rose-200 hover:bg-rose-500/20' : 'bg-surface-2 text-neutral-200 hover:bg-surface-3'
              )}
            >
              {cue.text}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSendCustom} className="flex gap-2">
        <input
          type="text"
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
          placeholder="Escribí un aviso…"
          className={inputClass}
          maxLength={120}
        />
        <IconButton label="Enviar aviso" type="submit" disabled={!customText.trim()} active className="w-11 h-11 rounded-2xl shrink-0">
          <Send className="w-4 h-4" />
        </IconButton>
      </form>

      {recentCues.length > 0 && (
        <div>
          <SectionLabel>Historial</SectionLabel>
          <ul className="flex flex-col gap-2">
            {recentCues.slice(0, 8).map((cue) => (
              <li key={cue.id} className="flex items-baseline gap-2 text-sm">
                <span className="text-xs text-neutral-600 tabular-nums shrink-0">
                  {new Date(cue.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-neutral-500 shrink-0">{cue.senderName}</span>
                <span className="text-neutral-200 min-w-0 break-words">{cue.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
};
