import React, { useEffect, useState } from 'react';
import { ListMusic, Plus, Pencil, Trash2 } from 'lucide-react';
import { NamedSetlist, RoomState } from '../types/metronome';
import {
  deleteSetlist,
  loadLastSelectedSetlistId,
  loadSetlistLibrary,
  newSetlistId,
  saveLastSelectedSetlistId,
  upsertSetlist,
} from '../utils/setlistLibrary';
import { SetlistManager } from './SetlistManager';
import { Button, Modal, inputClass } from './ui';

interface Props {
  /** Called with the chosen setlist, or undefined for "none". */
  onChange: (setlist: NamedSetlist | undefined) => void;
  canUseInRoom: boolean;
  roomHasSetlist: boolean;
}

export function SetlistPicker({ onChange, canUseInRoom, roomHasSetlist }: Props) {
  const [library, setLibrary] = useState(loadSetlistLibrary);
  const [selectedId, setSelectedId] = useState(() => {
    const last = loadLastSelectedSetlistId();
    return loadSetlistLibrary().some((l) => l.id === last) ? last : '';
  });
  const [draft, setDraft] = useState<NamedSetlist | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState('');
  const selected = library.find((list) => list.id === selectedId);

  // Report the remembered selection on first render too
  useEffect(() => {
    onChange(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const select = (id: string) => {
    setSelectedId(id);
    saveLastSelectedSetlistId(id);
    setConfirmDelete(false);
  };

  const previewRoom: RoomState | null = draft && {
    roomId: 'PREPARATION', roomName: draft.name, isPlaying: false, startServerTime: null,
    bpm: 120, countInBeats: 0, countInBars: 1, timeSignature: { numerator: 4, denominator: 4 },
    subdivision: '1', accentPattern: [2, 1, 1, 1], leaderId: null,
    currentSongId: null, setlist: draft.songs, setlistId: draft.id, setlistName: draft.name, members: [], recentCues: [],
  };

  const openEditor = (list?: NamedSetlist) => {
    setError('');
    setDraft(list ? { ...list, songs: [...list.songs] } : { id: newSetlistId(), name: '', songs: [] });
  };

  const save = () => {
    if (!draft || !draft.name.trim() || !draft.songs.length) return;
    const next = upsertSetlist({ ...draft, name: draft.name.trim() });
    if (!next) {
      setError('No se pudo guardar en este dispositivo. Revisá el espacio disponible o los permisos del navegador.');
      return;
    }
    setLibrary(next);
    select(draft.id);
    setDraft(null);
  };

  const remove = () => {
    if (!selected) return;
    const next = deleteSetlist(selected.id);
    if (next) {
      setLibrary(next);
      select('');
    }
  };

  return (
    <>
      <section className="rounded-2xl bg-surface-2 p-4 flex flex-col gap-3" aria-label="Setlist antes de entrar">
        <div className="flex items-center gap-2 text-sm text-white"><ListMusic className="w-4 h-4 text-accent" /> Setlist</div>
        <select
          aria-label="Elegir setlist"
          value={selectedId}
          onChange={(e) => select(e.target.value)}
          className="w-full min-w-0 h-11 px-3 bg-surface-3 text-white rounded-xl text-sm"
        >
          <option value="">{roomHasSetlist ? 'Usar el setlist de la sala' : 'Sin setlist'}</option>
          {library.map((list) => (
            <option key={list.id} value={list.id}>
              {list.name} · {list.songs.length} {list.songs.length === 1 ? 'tema' : 'temas'}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => openEditor()}><Plus className="w-4 h-4" /> Crear setlist</Button>
          {selected && <Button size="sm" onClick={() => openEditor(selected)}><Pencil className="w-3.5 h-3.5" /> Editar</Button>}
          {selected &&
            (confirmDelete ? (
              <Button size="sm" variant="danger" onClick={remove}>Confirmar borrado</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} aria-label={`Borrar ${selected.name}`}>
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            ))}
        </div>
        {selected && (
          <p className="text-xs text-neutral-300 truncate">
            {selected.songs.slice(0, 3).map((song) => song.title).join(' · ')}{selected.songs.length > 3 ? '…' : ''}
          </p>
        )}
        <p className="text-xs text-neutral-400 leading-relaxed">
          {roomHasSetlist
            ? 'La sala ya tiene un setlist y se conserva al entrar. Adentro, el baterista puede cambiarlo con «Cambiar».'
            : canUseInRoom
            ? 'El setlist elegido se carga al entrar como baterista. También se usa para practicar.'
            : 'Podés preparar tus listas para practicar. El baterista elige el setlist de la sala.'}
        </p>
      </section>
      <Modal
        open={Boolean(draft)}
        onClose={() => setDraft(null)}
        title={library.some((list) => list.id === draft?.id) ? 'Editar setlist' : 'Crear setlist'}
        subtitle="Dale un nombre y agregá tus temas. Queda guardado en este dispositivo."
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancelar</Button>
            <Button variant="primary" disabled={!draft?.name.trim() || !draft?.songs.length} onClick={save}>Guardar setlist</Button>
          </>
        }
      >
        {draft && previewRoom && (
          <>
            <label className="flex flex-col gap-2 text-sm text-neutral-300">
              Nombre del setlist
              <input
                autoFocus
                maxLength={80}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Ej.: Ensayo del viernes"
                className={inputClass}
              />
            </label>
            <SetlistManager
              key={draft.id}
              room={previewRoom}
              onSelectSong={() => {}}
              onUpdateSetlist={(songs) => setDraft((prev) => prev && { ...prev, songs })}
              isDrummer
              isOffline
              preparation
            />
            {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
          </>
        )}
      </Modal>
    </>
  );
}
