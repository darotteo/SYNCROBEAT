import React, { useState } from 'react';
import { UserPlus, Pencil, Crown } from 'lucide-react';
import { MemberInfo, InstrumentType, INSTRUMENT_TYPES } from '../types/metronome';
import { INSTRUMENT_METADATA } from './InstrumentIcon';
import { Button, Card, IconButton, cx, inputClass } from './ui';

interface MusiciansListProps {
  members: MemberInfo[];
  myId: string;
  isHost: boolean;
  onUpdateProfile: (name: string, instrument: InstrumentType) => void;
  onSetHost: (memberId: string) => void;
  onOpenShareModal: () => void;
}

function pingTone(ms: number) {
  if (ms <= 0) return 'bg-neutral-600';
  if (ms < 60) return 'bg-emerald-400';
  if (ms < 150) return 'bg-amber-400';
  return 'bg-rose-400';
}

const MusiciansListComponent: React.FC<MusiciansListProps> = ({
  members,
  myId,
  isHost,
  onUpdateProfile,
  onSetHost,
  onOpenShareModal,
}) => {
  const me = members.find((m) => m.id === myId);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editInstrument, setEditInstrument] = useState<InstrumentType>('other');
  const [confirmHostId, setConfirmHostId] = useState<string | null>(null);
  const drumsTakenByOther = members.some((m) => m.instrument === 'drums' && m.id !== myId);

  const startEdit = () => {
    if (!me) return;
    setEditName(me.name);
    setEditInstrument(me.instrument);
    setIsEditing(true);
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editName.trim()) return;
    onUpdateProfile(editName.trim(), editInstrument);
    setIsEditing(false);
  };

  const sorted = [...members].sort((a, b) => {
    if (a.isLeader !== b.isLeader) return a.isLeader ? -1 : 1;
    return a.joinedAt - b.joinedAt;
  });

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-neutral-400">
          {members.length} {members.length === 1 ? 'músico conectado' : 'músicos conectados'}
        </span>
        <Button size="sm" onClick={onOpenShareModal}>
          <UserPlus className="w-4 h-4" />
          Invitar
        </Button>
      </div>

      {isEditing && (
        <form onSubmit={handleSave} className="flex flex-col gap-3 p-4 rounded-2xl bg-surface-2">
          <input
            type="text"
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            maxLength={25}
            placeholder="Tu nombre"
            className={cx(inputClass, 'bg-surface-3')}
          />
          <div className="grid grid-cols-4 gap-2">
            {INSTRUMENT_TYPES.map((key) => {
              const meta = INSTRUMENT_METADATA[key];
              const locked = key === 'drums' && drumsTakenByOther;
              const selected = editInstrument === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={locked}
                  onClick={() => setEditInstrument(key)}
                  title={locked ? 'Batería ocupada' : meta.label}
                  className={cx(
                    'flex flex-col items-center gap-1 py-2 rounded-2xl transition-colors',
                    locked ? 'opacity-25' : selected ? 'bg-white text-black' : 'bg-surface-3 text-neutral-400 hover:text-white'
                  )}
                >
                  <span className="text-xl">{meta.emoji}</span>
                  <span className="text-[10px]">{meta.shortLabel}</span>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!editName.trim()}>
              Guardar
            </Button>
          </div>
        </form>
      )}

      <ul className="flex flex-col gap-1">
        {sorted.map((member) => {
          const isMe = member.id === myId;
          const meta = INSTRUMENT_METADATA[member.instrument] || INSTRUMENT_METADATA.other;
          return (
            <li key={member.id} className={cx('flex items-center gap-3 px-2 py-2 rounded-2xl', isMe && 'bg-surface-2')}>
              <div className="w-10 h-10 rounded-2xl bg-surface-3 flex items-center justify-center text-xl shrink-0">{meta.emoji}</div>
              <div className="flex-1 min-w-0">
                <div className="text-[15px] text-white truncate">
                  {member.name}
                  {isMe && <span className="text-neutral-500"> (vos)</span>}
                </div>
                <div className="text-xs text-neutral-500 truncate">
                  {meta.shortLabel}
                  {member.isLeader && <span className="text-accent"> · dirige la sala</span>}
                </div>
              </div>
              <span className="flex items-center gap-1.5 text-xs text-neutral-500 tabular-nums" title="Latencia de red">
                <span className={cx('w-1.5 h-1.5 rounded-full', pingTone(member.pingMs))} />
                {member.pingMs > 0 ? `${member.pingMs} ms` : '—'}
              </span>
              {isMe && !isEditing ? (
                <IconButton label="Editar mi perfil" onClick={startEdit}>
                  <Pencil className="w-4 h-4" />
                </IconButton>
              ) : isHost && !member.isLeader ? (
                confirmHostId === member.id ? (
                  <Button size="sm" variant="primary" onClick={() => { onSetHost(member.id); setConfirmHostId(null); }}>
                    Confirmar
                  </Button>
                ) : (
                  // Two steps: once handed over, only the new host can hand it back
                  <IconButton label={`Pasarle el control a ${member.name}`} onClick={() => setConfirmHostId(member.id)}>
                    <Crown className="w-4 h-4" />
                  </IconButton>
                )
              ) : (
                <span className="w-10" />
              )}
            </li>
          );
        })}
      </ul>

      {isHost && members.length > 1 && (
        <p className="text-xs text-neutral-500">
          Dirigís la sala: controlás el tempo y el setlist. Con <Crown className="w-3 h-3 inline -mt-0.5" /> le pasás el
          control a otro músico, toque o no la batería.
        </p>
      )}
    </Card>
  );
};

export const MusiciansList = React.memo(MusiciansListComponent);
