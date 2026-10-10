import React, { useState, useMemo, useRef } from 'react';
import {
  Plus,
  Pencil,
  ArrowUp,
  ArrowDown,
  Copy,
  Trash2,
  ClipboardPaste,
  Share2,
  Check,
  Minus,
  Music,
  FileDown,
  FileUp,
  FolderOpen,
  Save,
  ListMusic,
  GripVertical,
} from 'lucide-react';
import { SongItem, RoomState, TimeSignature, Subdivision, NamedSetlist, MIN_BPM, MAX_BPM, COMMON_SIGNATURES, defaultAccentPattern } from '../types/metronome';
import { loadSetlistLibrary, upsertSetlist, newSetlistId, saveLastSelectedSetlistId, syncSavedSetlist } from '../utils/setlistLibrary';
import { clampBpm, newSongId as newId, parsePastedList, parseSetlistJson } from '../utils/setlistParse';
import { Button, Card, IconButton, Modal, Segmented, cx, inputClass } from './ui';
import { SUBDIVISIONS } from './SignatureControls';

interface SetlistManagerProps {
  room: RoomState;
  onSelectSong: (songId: string) => void;
  onUpdateSetlist: (setlist: SongItem[], meta?: { id: string | null; name: string | null }) => void;
  isDrummer: boolean;
  isOffline: boolean;
  /** Editing a saved setlist before entering a room: no room actions, no library sync. */
  preparation?: boolean;
}

// ---------------------------------------------------------------------------
// Song editor (shared by "add" and "edit")
// ---------------------------------------------------------------------------

interface SongDraft {
  title: string;
  bpm: number;
  timeSignature: TimeSignature;
  subdivision: Subdivision;
  notes: string;
}

const SongEditor: React.FC<{
  initial: SongDraft;
  submitLabel: string;
  onSubmit: (draft: SongDraft) => void;
  onCancel: () => void;
  extraActions?: React.ReactNode;
}> = ({ initial, submitLabel, onSubmit, onCancel, extraActions }) => {
  const [draft, setDraft] = useState<SongDraft>(initial);
  const set = (patch: Partial<SongDraft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (draft.title.trim()) onSubmit({ ...draft, title: draft.title.trim(), bpm: clampBpm(draft.bpm) });
      }}
      onClick={(e) => e.stopPropagation()}
      className="flex flex-col gap-3 p-4 rounded-2xl bg-surface-2"
    >
      <input
        autoFocus
        type="text"
        value={draft.title}
        onChange={(e) => set({ title: e.target.value })}
        placeholder="Nombre del tema"
        aria-label="Nombre del tema"
        maxLength={80}
        className={cx(inputClass, 'bg-surface-3')}
      />

      <div className="flex items-center gap-2">
        <IconButton label="Restar 1 BPM" onClick={() => set({ bpm: clampBpm(draft.bpm - 1) })} className="bg-surface-3">
          <Minus className="w-4 h-4" />
        </IconButton>
        <div className="flex-1 flex items-baseline justify-center gap-1.5">
          <input
            type="number"
            inputMode="numeric"
            min={MIN_BPM}
            max={MAX_BPM}
            value={draft.bpm}
            onChange={(e) => set({ bpm: Number(e.target.value) })}
            onBlur={() => set({ bpm: clampBpm(draft.bpm) })}
            aria-label="BPM"
            className="w-20 bg-transparent text-center text-3xl font-light text-white tabular-nums focus:outline-none"
          />
          <span className="text-xs text-neutral-500">BPM</span>
        </div>
        <IconButton label="Sumar 1 BPM" onClick={() => set({ bpm: clampBpm(draft.bpm + 1) })} className="bg-surface-3">
          <Plus className="w-4 h-4" />
        </IconButton>
      </div>

      <details className="rounded-xl bg-surface-3/40 p-3">
        <summary className="cursor-pointer text-xs text-neutral-300">
          Compás, subdivisión y notas · {draft.timeSignature.numerator}/{draft.timeSignature.denominator}
        </summary>
        <div className="flex flex-col gap-3 mt-3">
          <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
            {COMMON_SIGNATURES.map((sig) => {
              const selected = draft.timeSignature.numerator === sig.numerator && draft.timeSignature.denominator === sig.denominator;
              return (
                <button
                  key={`${sig.numerator}/${sig.denominator}`}
                  type="button"
                  onClick={() => set({ timeSignature: sig })}
                  className={cx(
                    'shrink-0 h-9 px-3 rounded-xl text-xs tabular-nums transition-colors',
                    selected ? 'bg-white text-black font-medium' : 'bg-surface-3 text-neutral-400 hover:text-white'
                  )}
                >
                  {sig.numerator}/{sig.denominator}
                </button>
              );
            })}
          </div>

          <Segmented
            size="sm"
            value={draft.subdivision}
            onChange={(subdivision) => set({ subdivision })}
            options={SUBDIVISIONS.map((s) => ({ value: s.id, label: s.name }))}
            className="bg-surface-3"
          />

          <input
            type="text"
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Notas (opcional): entra bajo, corte en el solo…"
            maxLength={160}
            className={cx(inputClass, 'bg-surface-3')}
          />
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {extraActions}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!draft.title.trim()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------

const SetlistManagerComponent: React.FC<SetlistManagerProps> = ({
  room,
  onSelectSong,
  onUpdateSetlist,
  isDrummer,
  isOffline,
  preparation = false,
}) => {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showLibrary, setShowLibrary] = useState(false);
  const [library, setLibrary] = useState<NamedSetlist[]>([]);
  const [saveName, setSaveName] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const list = room.setlist;
  const canEdit = preparation || isOffline || isDrummer;
  const canSelect = !preparation && (isOffline || isDrummer);
  const [libraryVersion, setLibraryVersion] = useState(0);
  // The room list is a saved setlist of this device: edits are kept in sync with it.
  // Reading storage is memoized so playback updates never touch localStorage.
  const linkedToLibrary = useMemo(
    () => !preparation && canEdit && Boolean(room.setlistId) && loadSetlistLibrary().some((l) => l.id === room.setlistId),
    [preparation, canEdit, room.setlistId, libraryVersion]
  );

  const flash = (text: string) => {
    setNotice(text);
    window.setTimeout(() => setNotice((n) => (n === text ? null : n)), 3000);
  };

  const commit = (next: SongItem[]) => {
    onUpdateSetlist(next);
    if (linkedToLibrary) syncSavedSetlist(room.setlistId, room.setlistName, next);
  };

  const [fileSongs, setFileSongs] = useState<SongItem[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parsedPreview = useMemo(
    () => fileSongs ?? (pasteText.trim() ? parsePastedList(pasteText, room.bpm) : []),
    [fileSongs, pasteText, room.bpm]
  );

  const handleFile = async (file: File) => {
    setFileError(null);
    try {
      const text = await file.text();
      if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('[') || text.trim().startsWith('{')) {
        const { songs } = parseSetlistJson(text);
        if (songs.length === 0) throw new Error('empty');
        setFileSongs(songs);
      } else {
        setFileSongs(null);
        setPasteText(text);
      }
    } catch {
      setFileSongs(null);
      setFileError('No se pudo leer el archivo. Tiene que ser un setlist exportado desde SyncroBeat (.json) o un texto.');
    }
  };

  const closeImport = () => {
    setShowImport(false);
    setFileSongs(null);
    setFileError(null);
  };

  const handleExport = () => {
    if (list.length === 0) return;
    const name = room.setlistName || (isOffline ? 'setlist' : `setlist-${room.roomId.toLowerCase()}`);
    const payload = {
      app: 'SyncroBeat',
      version: 1,
      name: room.setlistName ?? undefined,
      exportedAt: new Date().toISOString(),
      songs: list.map(({ id, ...song }) => song),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/[^\w\- ]+/g, '').trim() || 'setlist'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('Setlist exportado');
  };

  const draftFromSong = (s: SongItem): SongDraft => ({
    title: s.title,
    bpm: s.bpm,
    timeSignature: s.timeSignature,
    subdivision: s.subdivision,
    notes: s.notes || '',
  });

  const songFromDraft = (draft: SongDraft, base?: SongItem): SongItem => {
    const keepPattern = base && base.timeSignature.numerator === draft.timeSignature.numerator;
    const notes = draft.notes.trim();
    return {
      id: base?.id ?? newId(),
      title: draft.title,
      bpm: draft.bpm,
      timeSignature: draft.timeSignature,
      subdivision: draft.subdivision,
      accentPattern: keepPattern ? base!.accentPattern : defaultAccentPattern(draft.timeSignature.numerator),
      ...(notes ? { notes } : {}),
    };
  };

  const handleAdd = (draft: SongDraft) => {
    commit([...list, songFromDraft(draft)]);
    setIsAdding(false);
  };

  const handleSave = (song: SongItem, draft: SongDraft) => {
    commit(list.map((s) => (s.id === song.id ? songFromDraft(draft, song) : s)));
    setEditingId(null);
  };

  const moveTo = (from: number, to: number) => {
    if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commit(next);
  };

  const handleMove = (index: number, dir: -1 | 1) => moveTo(index, index + dir);

  // --- Drag to reorder -----------------------------------------------------
  // Pointer events rather than HTML5 drag-and-drop, which does not fire on touch screens: this list
  // is mostly reordered on a phone during rehearsal.
  const rowRefs = useRef(new Map<string, HTMLLIElement | null>());
  const rowMidpoints = useRef<number[]>([]);
  // The live drag is held in a ref as well as in state: pointer moves must not depend on a re-render
  // having happened, or the first move of a gesture reads a stale `drag` and is dropped.
  const dragRef = useRef<{ id: string; to: number } | null>(null);
  const [drag, setDrag] = useState<{ id: string; to: number } | null>(null);

  const dragOrder = useMemo(() => {
    if (!drag) return list;
    const from = list.findIndex((s) => s.id === drag.id);
    if (from === -1 || from === drag.to) return list;
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(drag.to, 0, moved);
    return next;
  }, [drag, list]);

  const startDrag = (e: React.PointerEvent, song: SongItem, index: number) => {
    if (!canEdit || list.length < 2) return;
    const rects = list.map((s) => rowRefs.current.get(s.id)?.getBoundingClientRect());
    if (rects.some((r) => !r)) return;
    e.preventDefault();
    e.stopPropagation();
    // Midpoints are measured once, so the rows shifting under the finger cannot feed back into the aim
    rowMidpoints.current = rects.map((r) => r!.top + r!.height / 2);
    // Capture keeps the moves coming to this handle even when the finger outruns the row.
    // It throws if the pointer is already gone, which must not abort the drag itself.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    dragRef.current = { id: song.id, to: index };
    setDrag(dragRef.current);
  };

  const moveDrag = (e: React.PointerEvent) => {
    const current = dragRef.current;
    if (!current) return;
    const midpoints = rowMidpoints.current;
    const above = midpoints.findIndex((mid) => e.clientY < mid);
    const to = above === -1 ? midpoints.length - 1 : above;
    if (to !== current.to) {
      dragRef.current = { ...current, to };
      setDrag(dragRef.current);
    }
  };

  const endDrag = () => {
    const current = dragRef.current;
    if (!current) return;
    dragRef.current = null;
    setDrag(null);
    moveTo(list.findIndex((s) => s.id === current.id), current.to);
  };

  const handleDuplicate = (song: SongItem, index: number) => {
    const next = [...list];
    next.splice(index + 1, 0, { ...song, id: newId(), title: `${song.title} (copia)` });
    commit(next);
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    commit(list.filter((s) => s.id !== id));
    setConfirmDeleteId(null);
    setEditingId(null);
  };

  const handleImport = (mode: 'replace' | 'append') => {
    if (parsedPreview.length === 0) return;
    commit(mode === 'replace' ? parsedPreview : [...list, ...parsedPreview]);
    setPasteText('');
    closeImport();
    flash(`${parsedPreview.length} temas importados`);
  };

  const handleShare = async () => {
    if (list.length === 0) return;
    const title = room.setlistName || (isOffline ? 'Setlist' : `Setlist · ${room.roomName}`);
    const lines = list.map((s, i) => `${i + 1}. ${s.title} - ${s.bpm} BPM${s.notes ? ` (${s.notes})` : ''}`);
    const text = `${title}\n\n${lines.join('\n')}`;
    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        return;
      }
    } catch {
      return; // Cancelled by the user
    }
    try {
      await navigator.clipboard.writeText(text);
      flash('Setlist copiado al portapapeles');
    } catch {}
  };

  const openLibrary = () => {
    setLibrary(loadSetlistLibrary());
    setShowLibrary(true);
  };

  const handleLoad = (saved: NamedSetlist) => {
    onUpdateSetlist(saved.songs, { id: saved.id, name: saved.name });
    saveLastSelectedSetlistId(saved.id);
    setShowLibrary(false);
    setEditingId(null);
    setIsAdding(false);
    flash(`«${saved.name}» cargado`);
  };

  /** Saves the room list as a new setlist on this device (and names the room list, when allowed). */
  const handleSaveAsNew = () => {
    const name = (saveName || '').trim();
    if (!name || list.length === 0) return;
    const saved: NamedSetlist = { id: newSetlistId(), name, songs: list };
    if (!upsertSetlist(saved)) {
      flash('No se pudo guardar en este dispositivo');
      return;
    }
    if (canEdit) onUpdateSetlist(list, { id: saved.id, name: saved.name });
    saveLastSelectedSetlistId(saved.id);
    setLibraryVersion((v) => v + 1);
    setSaveName(null);
    flash(`Guardado como «${name}»`);
  };

  const listTitle = room.setlistName || (list.length ? 'Setlist de la sala' : 'Sin setlist');

  return (
    <Card className="flex flex-col gap-4">
      {/* Header: which setlist this is and where it is saved */}
      {!preparation && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-base text-white">
              <ListMusic className="w-4 h-4 text-accent shrink-0" />
              <span className="truncate">{listTitle}</span>
            </div>
            <p className="text-xs text-neutral-500 mt-0.5">
              {list.length} {list.length === 1 ? 'tema' : 'temas'}
              {linkedToLibrary && ' · los cambios se guardan en tus setlists'}
            </p>
          </div>
          {canEdit && (
            <Button size="sm" onClick={openLibrary}>
              <FolderOpen className="w-4 h-4" />
              Cambiar
            </Button>
          )}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {canEdit && (
          <Button
            size="sm"
            variant={isAdding ? 'primary' : 'secondary'}
            onClick={() => {
              setIsAdding((v) => !v);
              setEditingId(null);
            }}
          >
            <Plus className="w-4 h-4" />
            Agregar tema
          </Button>
        )}
        {canEdit && (
          <Button size="sm" onClick={() => setShowImport(true)}>
            <ClipboardPaste className="w-4 h-4" />
            Importar
          </Button>
        )}
        <div className="flex-1" />
        {list.length > 0 && !preparation && !linkedToLibrary && (
          <IconButton label="Guardar en mis setlists" onClick={() => setSaveName(room.setlistName || '')}>
            <Save className="w-4 h-4" />
          </IconButton>
        )}
        {list.length > 0 && !preparation && (
          <>
            <IconButton label="Exportar setlist a un archivo" onClick={handleExport}>
              <FileDown className="w-4 h-4" />
            </IconButton>
            <IconButton label="Compartir setlist como texto" onClick={handleShare}>
              <Share2 className="w-4 h-4" />
            </IconButton>
          </>
        )}
      </div>

      {saveName !== null && (
        <form
          className="flex flex-col gap-2 p-4 rounded-2xl bg-surface-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSaveAsNew();
          }}
        >
          <label className="text-xs text-neutral-400" htmlFor="save-setlist-name">
            Guardar en mis setlists (en este dispositivo)
          </label>
          <input
            id="save-setlist-name"
            autoFocus
            maxLength={80}
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Ej.: Ensayo del viernes"
            className={cx(inputClass, 'bg-surface-3')}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSaveName(null)}>
              Cancelar
            </Button>
            <Button size="sm" variant="primary" type="submit" disabled={!saveName.trim()}>
              Guardar
            </Button>
          </div>
        </form>
      )}

      {!isOffline && !preparation && !isDrummer && (
        <p className="text-xs text-neutral-500">Solo el baterista elige y cambia los temas de la sala.</p>
      )}

      {notice && (
        <div className="flex items-center gap-2 text-sm text-accent animate-fade-in" role="status">
          <Check className="w-4 h-4" />
          {notice}
        </div>
      )}

      {isAdding && (
        <SongEditor
          initial={{ title: '', bpm: room.bpm, timeSignature: room.timeSignature, subdivision: room.subdivision, notes: '' }}
          submitLabel="Agregar tema"
          onSubmit={handleAdd}
          onCancel={() => setIsAdding(false)}
        />
      )}

      {/* Songs */}
      {list.length === 0 && !isAdding ? (
        <div className="flex flex-col items-center text-center gap-3 py-8">
          <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center text-neutral-500">
            <Music className="w-5 h-5" />
          </div>
          <p className="text-sm text-neutral-400 max-w-xs">
            {canEdit
              ? preparation
                ? 'Agregá los temas de a uno o pegá la lista entera desde WhatsApp o tus notas.'
                : 'Cargá uno de tus setlists con «Cambiar», agregá temas o pegá la lista entera.'
              : 'El baterista todavía no cargó el setlist de la sala.'}
          </p>
        </div>
      ) : (
        <ol className={cx('flex flex-col gap-1', drag && 'select-none')}>
          {dragOrder.map((song, index) => {
            const isCurrent = !preparation && room.currentSongId === song.id;
            const isEditing = editingId === song.id;

            if (isEditing) {
              return (
                <li key={song.id} ref={(el) => { rowRefs.current.set(song.id, el); }}>
                  <SongEditor
                    initial={draftFromSong(song)}
                    submitLabel="Guardar"
                    onSubmit={(draft) => handleSave(song, draft)}
                    onCancel={() => setEditingId(null)}
                    extraActions={
                      <>
                        <IconButton label="Subir" disabled={index === 0} onClick={() => handleMove(index, -1)}>
                          <ArrowUp className="w-4 h-4" />
                        </IconButton>
                        <IconButton label="Bajar" disabled={index === list.length - 1} onClick={() => handleMove(index, 1)}>
                          <ArrowDown className="w-4 h-4" />
                        </IconButton>
                        <IconButton label="Duplicar" onClick={() => handleDuplicate(song, index)}>
                          <Copy className="w-4 h-4" />
                        </IconButton>
                        {confirmDeleteId === song.id ? (
                          <Button size="sm" variant="danger" onClick={() => handleDelete(song.id)}>
                            Confirmar borrado
                          </Button>
                        ) : (
                          <IconButton label="Eliminar" onClick={() => setConfirmDeleteId(song.id)} className="hover:text-rose-400">
                            <Trash2 className="w-4 h-4" />
                          </IconButton>
                        )}
                      </>
                    }
                  />
                </li>
              );
            }

            const isDragging = drag?.id === song.id;

            return (
              <li key={song.id} ref={(el) => { rowRefs.current.set(song.id, el); }}>
                <div
                  role={canSelect ? 'button' : undefined}
                  tabIndex={canSelect ? 0 : undefined}
                  onClick={() => canSelect && !drag && onSelectSong(song.id)}
                  onKeyDown={(e) => {
                    if (canSelect && (e.key === 'Enter' || e.key === ' ')) {
                      e.preventDefault();
                      onSelectSong(song.id);
                    }
                  }}
                  className={cx(
                    'group flex items-center gap-3 pr-1 py-2.5 rounded-2xl transition-colors',
                    canEdit ? 'pl-0.5' : 'pl-3',
                    isCurrent ? 'bg-surface-2' : canSelect ? 'hover:bg-surface-2/60' : '',
                    canSelect && !drag && 'cursor-pointer',
                    isDragging && 'bg-surface-3 shadow-lg ring-1 ring-accent/40'
                  )}
                >
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Mover ${song.title}. Arrastrá, o usá las flechas arriba y abajo.`}
                      onPointerDown={(e) => startDrag(e, song, index)}
                      onPointerMove={moveDrag}
                      onPointerUp={endDrag}
                      onPointerCancel={endDrag}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                        e.preventDefault();
                        e.stopPropagation();
                        moveTo(index, index + (e.key === 'ArrowUp' ? -1 : 1));
                      }}
                      className={cx(
                        'shrink-0 p-1.5 rounded-xl text-neutral-600 touch-none',
                        'hover:text-neutral-300 hover:bg-surface-3 focus-visible:text-neutral-300',
                        isDragging ? 'cursor-grabbing text-accent' : 'cursor-grab'
                      )}
                    >
                      <GripVertical className="w-4 h-4" />
                    </button>
                  )}
                  <span className={cx('w-6 text-right text-sm tabular-nums shrink-0', isCurrent ? 'text-accent' : 'text-neutral-600')}>
                    {index + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={cx('text-[15px] truncate', isCurrent ? 'text-white font-medium' : 'text-neutral-200')}>
                      {song.title}
                    </div>
                    <div className="text-xs text-neutral-500 truncate">
                      {isCurrent && <span className="text-accent">Actual · </span>}
                      {song.timeSignature.numerator}/{song.timeSignature.denominator}
                      {song.subdivision !== '1' && ` · ${SUBDIVISIONS.find((s) => s.id === song.subdivision)?.name}`}
                      {song.notes && ` · ${song.notes}`}
                    </div>
                  </div>
                  <span className={cx('text-xl font-light tabular-nums shrink-0', isCurrent ? 'text-white' : 'text-neutral-300')}>
                    {song.bpm}
                  </span>
                  {canEdit ? (
                    <IconButton
                      label={`Editar ${song.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(song.id);
                        setConfirmDeleteId(null);
                        setIsAdding(false);
                      }}
                    >
                      <Pencil className="w-4 h-4" />
                    </IconButton>
                  ) : (
                    <span className="w-2" />
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {canEdit && list.length > 0 && (
        <div className="flex justify-end">
          {confirmClear ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-400">¿Vaciar la lista?</span>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                No
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  // Clearing never wipes the saved setlist: the room simply stops using it
                  onUpdateSetlist([], preparation ? undefined : { id: null, name: null });
                  setConfirmClear(false);
                }}
              >
                Vaciar
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmClear(true)}
              className="text-xs text-neutral-600 hover:text-rose-400 transition-colors"
            >
              Vaciar lista
            </button>
          )}
        </div>
      )}

      {/* Load one of the saved setlists */}
      <Modal open={showLibrary} onClose={() => setShowLibrary(false)} title="Cambiar setlist" subtitle="Tus setlists guardados en este dispositivo">
        {library.length === 0 ? (
          <p className="text-sm text-neutral-400">
            Todavía no guardaste setlists. Armá uno en la pantalla de inicio, o guardá esta lista con el ícono de disquete.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {library.map((saved) => {
              const isCurrent = saved.id === room.setlistId;
              return (
                <li key={saved.id}>
                  <button
                    type="button"
                    onClick={() => handleLoad(saved)}
                    className={cx(
                      'w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-left transition-colors',
                      isCurrent ? 'bg-surface-2' : 'hover:bg-surface-2/60'
                    )}
                  >
                    <ListMusic className={cx('w-4 h-4 shrink-0', isCurrent ? 'text-accent' : 'text-neutral-500')} />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-white truncate">{saved.name}</span>
                      <span className="block text-xs text-neutral-500 truncate">
                        {saved.songs.length} {saved.songs.length === 1 ? 'tema' : 'temas'}
                        {saved.songs.length > 0 && ` · ${saved.songs.slice(0, 3).map((s) => s.title).join(', ')}`}
                      </span>
                    </span>
                    {isCurrent && <span className="text-xs text-accent shrink-0">En uso</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {list.length > 0 && !linkedToLibrary && library.length > 0 && (
          <p className="text-xs text-neutral-500">Ojo: la lista actual de la sala no está guardada y se va a reemplazar.</p>
        )}
      </Modal>

      <Modal
        open={showImport}
        onClose={closeImport}
        title="Importar temas"
        subtitle="Pegá la lista (un tema por línea, con su BPM) o abrí un archivo exportado."
        footer={
          <>
            {list.length > 0 && (
              <Button size="md" disabled={parsedPreview.length === 0} onClick={() => handleImport('append')}>
                Agregar al final
              </Button>
            )}
            <Button size="md" variant="primary" disabled={parsedPreview.length === 0} onClick={() => handleImport('replace')}>
              {list.length > 0 ? 'Reemplazar' : 'Importar'}
              {parsedPreview.length > 0 && ` (${parsedPreview.length})`}
            </Button>
          </>
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.txt,application/json,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
            e.target.value = '';
          }}
        />
        <Button size="md" onClick={() => fileInputRef.current?.click()} className="w-full">
          <FileUp className="w-4 h-4" />
          Abrir archivo (.json o .txt)
        </Button>
        {fileError && <p className="text-sm text-rose-300">{fileError}</p>}
        {fileSongs && (
          <div className="flex items-center justify-between text-sm text-accent">
            <span>Archivo cargado: {fileSongs.length} temas</span>
            <button type="button" onClick={() => setFileSongs(null)} className="text-xs text-neutral-500 hover:text-white">
              Quitar
            </button>
          </div>
        )}
        <textarea
          rows={7}
          value={pasteText}
          disabled={Boolean(fileSongs)}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder={'1. Intro - 110\n2. Segundo tema - 95 bpm\n3. Balada (voz sola) 72'}
          className="w-full p-4 bg-surface-2 rounded-2xl text-sm text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600 resize-none"
        />
        {parsedPreview.length > 0 && (
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {parsedPreview.map((item, idx) => (
              <div key={item.id} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-surface-2 text-sm">
                <span className="w-5 text-right text-neutral-600 tabular-nums">{idx + 1}</span>
                <span className="flex-1 truncate text-neutral-200">
                  {item.title}
                  {item.notes && <span className="text-neutral-500"> · {item.notes}</span>}
                </span>
                <span className="tabular-nums text-neutral-300">{item.bpm}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  );
};

export const SetlistManager = React.memo(SetlistManagerComponent);
