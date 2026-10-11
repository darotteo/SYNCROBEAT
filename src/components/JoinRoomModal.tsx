import React, { useState, useEffect } from 'react';
import { WifiOff, Download, RefreshCw, Mic, ChevronDown } from 'lucide-react';
import { InstrumentType, INSTRUMENT_TYPES, NamedSetlist } from '../types/metronome';
import { INSTRUMENT_METADATA } from './InstrumentIcon';
import { audioEngine } from '../utils/audioEngine';
import { getClientId } from '../utils/clientId';
import { cx } from './ui';
import { SetlistPicker } from './SetlistPicker';
import { Brand } from './Brand';
import { TunerPanel } from './TunerPanel';

interface JoinRoomModalProps {
  isOpen: boolean;
  initialRoomId?: string;
  onJoin: (roomId: string, name: string, instrument: InstrumentType, initialSetlist?: NamedSetlist) => void;
  onStartOffline: (setlist?: NamedSetlist) => void;
  onOpenInstallModal: () => void;
  isConnecting: boolean;
  isInstalled?: boolean;
  error?: string | null;
}

const PROFILE_KEY = 'syncbeat_last_profile';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No 0/O or 1/I to avoid typos

function randomRoomCode() {
  let code = '';
  const values = new Uint32Array(6);
  crypto.getRandomValues(values);
  values.forEach((v) => (code += CODE_ALPHABET[v % CODE_ALPHABET.length]));
  return code;
}

function loadProfile(): { name: string; instrument: InstrumentType } {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
    return {
      name: typeof saved.name === 'string' ? saved.name : '',
      instrument: INSTRUMENT_TYPES.includes(saved.instrument) ? saved.instrument : 'drums',
    };
  } catch {
    return { name: '', instrument: 'drums' };
  }
}

const fieldClass =
  'w-full px-5 py-4 bg-surface-2 rounded-2xl text-center text-lg font-light text-white placeholder-neutral-600 focus:outline-none focus:ring-1 focus:ring-neutral-600 transition-shadow';

export const JoinRoomModal: React.FC<JoinRoomModalProps> = ({
  isOpen,
  initialRoomId = '',
  onJoin,
  onStartOffline,
  onOpenInstallModal,
  isConnecting,
  isInstalled = false,
  error,
}) => {
  const [roomId, setRoomId] = useState(() => initialRoomId.toUpperCase() || randomRoomCode());
  const [name, setName] = useState(() => loadProfile().name);
  const [instrument, setInstrument] = useState<InstrumentType>(() => loadProfile().instrument);
  const [isDrumsTaken, setIsDrumsTaken] = useState(false);
  const [roomHasSetlist, setRoomHasSetlist] = useState(false);
  const [showTuner, setShowTuner] = useState(false);
  // Nobody inside yet, so this join opens the room and gets to run it
  const [willOpenRoom, setWillOpenRoom] = useState(true);
  const [selectedSetlist, setSelectedSetlist] = useState<NamedSetlist | undefined>();

  // Check whether the room already has a drummer
  useEffect(() => {
    if (!isOpen) return;
    const code = roomId.trim();
    if (!code) {
      setIsDrumsTaken(false);
      setRoomHasSetlist(false);
      setWillOpenRoom(true);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(code)}?clientId=${encodeURIComponent(getClientId())}`);
        const data = res.ok ? await res.json() : null;
        if (!cancelled) {
          setIsDrumsTaken(Boolean(data?.drumsTaken));
          setRoomHasSetlist(Boolean(data?.setlistCount));
          setWillOpenRoom(!data?.membersCount);
        }
      } catch {
        if (!cancelled) {
          setIsDrumsTaken(false);
          setRoomHasSetlist(false);
          setWillOpenRoom(true);
        }
      }
    };
    const debounce = window.setTimeout(check, 250);
    const interval = window.setInterval(check, 4000);
    return () => {
      cancelled = true;
      window.clearTimeout(debounce);
      window.clearInterval(interval);
    };
  }, [roomId, isOpen]);

  useEffect(() => {
    if (isDrumsTaken && instrument === 'drums') setInstrument('guitar');
  }, [isDrumsTaken, instrument]);

  if (!isOpen) return null;

  const drumsBlocked = instrument === 'drums' && isDrumsTaken;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const code = roomId.trim().toUpperCase();
    if (!code || drumsBlocked) return;
    // Unlock audio synchronously inside the tap (required by iOS Safari)
    audioEngine.unlockAudio();
    const finalName = name.trim() || 'Músico';
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: finalName, instrument }));
    } catch {}
    onJoin(code, finalName, instrument, instrument === 'drums' ? selectedSetlist : undefined);
  };

  return (
    <div className="join-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto animate-fade-in">
      <div className="brand-panel w-full max-w-sm rounded-[2rem] p-6 shadow-2xl flex flex-col gap-5 my-auto">
        <div className="text-center">
          <Brand hero />
          <p className="text-sm text-neutral-400 mt-3 font-light">El mismo click para toda la banda.</p>
        </div>

        <form id="join-room" onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="relative">
            <input
              type="text"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20))}
              placeholder="Código de sala"
              aria-label="Código de sala"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className={cx(fieldClass, 'tracking-widest')}
              required
            />
            <button
              type="button"
              onClick={() => setRoomId(randomRoomCode())}
              title="Crear una sala nueva"
              aria-label="Generar código de sala nuevo"
              className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl flex items-center justify-center text-neutral-600 hover:text-white hover:bg-surface-3 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>

          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tu nombre"
            aria-label="Tu nombre"
            className={fieldClass}
            maxLength={25}
            autoFocus={Boolean(initialRoomId)}
          />

          <div className="grid grid-cols-4 gap-2.5 mt-1">
            {INSTRUMENT_TYPES.map((key) => {
              const meta = INSTRUMENT_METADATA[key];
              const isSelected = instrument === key;
              const isLocked = key === 'drums' && isDrumsTaken;

              return (
                <button
                  key={key}
                  type="button"
                  disabled={isLocked}
                  onClick={() => setInstrument(key)}
                  aria-pressed={isSelected}
                  className={cx(
                    'flex flex-col items-center justify-center gap-1.5 py-3 px-1 rounded-2xl transition-all',
                    isLocked
                      ? 'opacity-25 cursor-not-allowed bg-surface-2'
                      : isSelected
                      ? 'bg-brand text-black shadow-lg shadow-brand/10'
                      : 'bg-surface-2 hover:bg-surface-3 text-neutral-400 hover:text-white'
                  )}
                  title={isLocked ? 'Ya hay baterista en esta sala' : meta.label}
                >
                  <span className="text-2xl">{meta.emoji}</span>
                  <span className={cx('text-[10px] tracking-tight', isSelected ? 'text-black font-semibold' : 'text-neutral-400')}>
                    {meta.shortLabel}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="text-xs text-neutral-400 text-center -mt-1">
            {isDrumsTaken
              ? 'Esta sala ya tiene baterista. Elegí otro instrumento.'
              : 'Quien abre la sala la dirige, toque lo que toque, y después puede pasarle el control a cualquiera.'}
          </p>

          {error && <p className="text-sm text-rose-300 text-center">{error}</p>}
        </form>

        <SetlistPicker onChange={setSelectedSetlist} canUseInRoom={willOpenRoom} roomHasSetlist={roomHasSetlist} />

        {/* Collapsed by default: useful before a rehearsal, but it must not push the room code and
            the Entrar button off the screen on a phone. */}
        <section>
          <button
            type="button"
            onClick={() => setShowTuner((v) => !v)}
            aria-expanded={showTuner}
            className="w-full flex items-center justify-between py-2 text-xs font-medium uppercase tracking-[0.12em] text-neutral-500 hover:text-neutral-300 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Mic className="w-3.5 h-3.5" />
              Afinador
            </span>
            <ChevronDown className={cx('w-4 h-4 transition-transform', showTuner && 'rotate-180')} />
          </button>
          {showTuner && <TunerPanel isPlaying={false} />}
        </section>

          <button
            type="submit"
            form="join-room"
            disabled={isConnecting || !roomId.trim() || drumsBlocked}
            className="brand-primary w-full py-4 disabled:opacity-30 text-black font-medium text-lg rounded-2xl transition-all active:scale-95 shadow-lg"
          >
            {isConnecting ? 'Conectando…' : 'Entrar'}
          </button>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={() => onStartOffline(selectedSetlist)}
              className="text-xs text-neutral-500 hover:text-white transition-colors flex items-center gap-1.5"
            >
              <WifiOff className="w-3.5 h-3.5" />
              Practicar sin conexión
            </button>
            {!isInstalled && (
              <button
                type="button"
                onClick={onOpenInstallModal}
                className="text-xs text-neutral-500 hover:text-white transition-colors flex items-center gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
                Instalar app
              </button>
            )}
          </div>
      </div>
    </div>
  );
};
