import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Settings2,
  Volume2,
  VolumeX,
  MoreHorizontal,
  QrCode,
  Smartphone,
  Download,
  LogOut,
  WifiOff,
  Loader2,
  MonitorPlay,
} from 'lucide-react';
import { useSyncBeat } from './hooks/useSyncBeat';
import { usePWAInstall } from './hooks/usePWAInstall';
import { audioEngine } from './utils/audioEngine';
import { isNativeApp, setNativeScreenAwake } from './utils/mobile';
import { syncSavedSetlist } from './utils/setlistLibrary';
import { BeatVisualizer } from './components/BeatVisualizer';
import { TempoControls } from './components/TempoControls';
import { SignatureControls } from './components/SignatureControls';
import { MusiciansList } from './components/MusiciansList';
import { RehearsalCues } from './components/RehearsalCues';
import { TunerPanel } from './components/TunerPanel';
import { SetlistManager } from './components/SetlistManager';
import { LocalAudioSettingsModal } from './components/LocalAudioSettingsModal';
import { LatencyControl } from './components/LatencyControl';
import { Brand } from './components/Brand';
import { JoinRoomModal } from './components/JoinRoomModal';
import { ShareRoomModal } from './components/ShareRoomModal';
import { LockScreenGuideModal } from './components/LockScreenGuideModal';
import { DownloadAppModal } from './components/DownloadAppModal';
import { StageMode } from './components/StageMode';
import { IconButton, Segmented, cx } from './components/ui';

type Tab = 'setlist' | 'band' | 'cues' | 'tuner';

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === 'true';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export default function App() {
  const {
    isConnected,
    isConnecting,
    isOfflineMode,
    room,
    myId,
    latencyMs,
    bluetoothOffsetMs,
    joinError,
    joinRoom,
    leaveRoom,
    startOfflineMode,
    recalibrateClock,
    setBluetoothOffset,
    togglePlay,
    setBpm,
    adjustBpm,
    tapTempo,
    setTimeSignature,
    setSubdivision,
    toggleAccentAt,
    setCountInBars,
    sendCue,
    selectSong,
    updateSetlist,
    updateProfile,
    setHost,
    activeCue,
  } = useSyncBeat();

  const { isInstalled, isIOS, canPromptNative, install } = usePWAInstall();

  const urlRoomId = useMemo(() => new URLSearchParams(window.location.search).get('room') || '', []);

  const [isAudioModalOpen, setIsAudioModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [isLockScreenModalOpen, setIsLockScreenModalOpen] = useState(false);
  const [isDownloadModalOpen, setIsDownloadModalOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isStageOpen, setIsStageOpen] = useState(false);
  const closeStage = useCallback(() => setIsStageOpen(false), []);
  const [activeTab, setActiveTab] = useState<Tab>('setlist');
  const [isMuted, setIsMutedState] = useState(audioEngine.getMuted());
  const [audioContextState, setAudioContextState] = useState<string>('running');
  const [keepScreenAwake, setKeepScreenAwake] = useState(() => readFlag('syncbeat_keep_screen_awake', true));
  const [fullScreenFlash, setFullScreenFlash] = useState(() => readFlag('syncbeat_fullscreen_flash', false));

  const isJoinOpen = !room;

  const setMuted = useCallback((muted: boolean) => {
    setIsMutedState(muted);
    audioEngine.setMuted(muted);
  }, []);

  const handleToggleKeepScreenAwake = (value: boolean) => {
    setKeepScreenAwake(value);
    writeFlag('syncbeat_keep_screen_awake', value);
  };

  const handleToggleFlash = useCallback(() => {
    setFullScreenFlash((prev) => {
      writeFlag('syncbeat_fullscreen_flash', !prev);
      return !prev;
    });
  }, []);

  const handleInstallApp = async () => {
    setIsMenuOpen(false);
    const result = await install();
    if (result !== 'accepted') setIsDownloadModalOpen(true);
  };

  // Track AudioContext state (iOS suspends it in the background)
  useEffect(() => audioEngine.onStateChange(setAudioContextState), []);

  // Keep the screen on while in a room
  useEffect(() => {
    if (isNativeApp()) {
      setNativeScreenAwake(Boolean(room) && keepScreenAwake);
      return () => setNativeScreenAwake(false);
    }
    if (!room || !keepScreenAwake || !('wakeLock' in navigator)) return;
    let wakeLock: WakeLockSentinel | null = null;
    let cancelled = false;

    const request = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) lock.release().catch(() => {});
        else wakeLock = lock;
      } catch {}
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') request();
    };

    request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      wakeLock?.release().catch(() => {});
    };
  }, [Boolean(room), keepScreenAwake]);

  const myMember = room?.members.find((m) => m.id === myId);
  // Running the room is a role, not an instrument: the host can hand it to anybody in the room
  const isHost = isOfflineMode || Boolean(myMember?.isLeader);
  const hostMember = room?.members.find((m) => m.isLeader);

  const currentSongIndex = room ? room.setlist.findIndex((s) => s.id === room.currentSongId) : -1;
  const currentSong = currentSongIndex >= 0 ? room!.setlist[currentSongIndex] : undefined;

  const handleNextSong = useCallback(() => {
    if (!room || room.setlist.length === 0) return;
    selectSong(room.setlist[(currentSongIndex + 1) % room.setlist.length].id);
  }, [room, currentSongIndex, selectSong]);

  const handlePrevSong = useCallback(() => {
    if (!room || room.setlist.length === 0) return;
    const prev = currentSongIndex <= 0 ? room.setlist.length - 1 : currentSongIndex - 1;
    selectSong(room.setlist[prev].id);
  }, [room, currentSongIndex, selectSong]);

  const handleSaveBpmToSong = useCallback(() => {
    if (!room || !currentSong) return;
    const next = room.setlist.map((s) =>
      s.id === currentSong.id
        ? {
            ...s,
            bpm: room.bpm,
            timeSignature: room.timeSignature,
            subdivision: room.subdivision,
            accentPattern: room.accentPattern,
          }
        : s
    );
    updateSetlist(next);
    syncSavedSetlist(room.setlistId, room.setlistName, next);
  }, [room, currentSong, updateSetlist]);

  // Keyboard shortcuts. Bluetooth page-turner pedals send PageUp / PageDown or arrow keys.
  useEffect(() => {
    if (!room) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable) return;
      if (document.querySelector('[role="dialog"]')) return;
      // A focused button already reacts to Space / Enter on its own
      if (target?.tagName === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;

      if (e.code === 'KeyF') {
        e.preventDefault();
        setIsStageOpen((v) => !v);
        return;
      }
      if (!isHost) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowUp':
          e.preventDefault();
          adjustBpm(e.shiftKey ? 5 : 1);
          break;
        case 'ArrowDown':
          e.preventDefault();
          adjustBpm(e.shiftKey ? -5 : -1);
          break;
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault();
          handleNextSong();
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          handlePrevSong();
          break;
        case 'KeyT':
          e.preventDefault();
          tapTempo();
          break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [room, isHost, togglePlay, adjustBpm, tapTempo, handleNextSong, handlePrevSong]);

  // Lock-screen / headphone controls
  useEffect(() => {
    if (!room || !('mediaSession' in navigator)) return;
    const songTitle = currentSong ? currentSong.title : 'Metrónomo';
    audioEngine.updateMediaSession({
      title: songTitle,
      artist: isOfflineMode ? 'Práctica local' : `Sala ${room.roomId}${hostMember ? ` · ${hostMember.name}` : ''}`,
      album: `${room.bpm} BPM · ${room.timeSignature.numerator}/${room.timeSignature.denominator}`,
      isPlaying: room.isPlaying,
    });

    try {
      const playPause = () => (isHost ? togglePlay() : setMuted(!audioEngine.getMuted()));
      navigator.mediaSession.setActionHandler('play', playPause);
      navigator.mediaSession.setActionHandler('pause', playPause);
      navigator.mediaSession.setActionHandler('nexttrack', isHost ? handleNextSong : null);
      navigator.mediaSession.setActionHandler('previoustrack', isHost ? handlePrevSong : null);
    } catch {}
  }, [room, currentSong, hostMember, isHost, isOfflineMode, togglePlay, setMuted, handleNextSong, handlePrevSong]);

  const handleLeave = () => {
    setIsMenuOpen(false);
    leaveRoom();
  };

  const needsAudioTap = room?.isPlaying && audioContextState !== 'running';
  const isReconnecting = Boolean(room) && !isOfflineMode && !isConnected;

  return (
    <div className="min-h-screen bg-bg text-neutral-100 flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-bg/85 backdrop-blur-xl border-b border-line pt-[env(safe-area-inset-top)]">
        <div className="max-w-6xl mx-auto px-3 sm:px-4 lg:px-8 h-16 flex items-center gap-1.5 sm:gap-3">
          <Brand />

          {room && (
            <>
              {isOfflineMode ? (
                <span className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-xl bg-surface-2 text-sm text-neutral-300">
                  <WifiOff className="w-4 h-4 text-neutral-500" />
                  Práctica local
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsShareModalOpen(true)}
                  title="Invitar a la sala"
                  className="hidden sm:flex items-center gap-2 h-9 px-3 rounded-xl bg-surface-2 hover:bg-surface-3 transition-colors min-w-0"
                >
                  <span
                    className={cx('w-2 h-2 rounded-full shrink-0', isConnected ? 'bg-emerald-400' : 'bg-amber-400 animate-pulse')}
                    title={isConnected ? 'Conectado' : 'Reconectando'}
                  />
                  <span className="text-xs sm:text-sm tracking-wider text-white whitespace-nowrap">{room.roomId}</span>
                  <QrCode className="hidden sm:block w-4 h-4 text-neutral-500 shrink-0" />
                </button>
              )}

              {!isOfflineMode && isConnected && (
                <span className="hidden md:block text-xs text-neutral-600 tabular-nums" title="Latencia de red">
                  {latencyMs} ms
                </span>
              )}

              <div className="flex-1" />

              <button
                type="button"
                onClick={() => setIsStageOpen(true)}
                title="Modo atril: pantalla completa para tocar (tecla F)"
                className="flex items-center gap-2 h-10 px-2.5 sm:px-3 rounded-xl text-sm text-neutral-300 hover:text-white hover:bg-surface-2 transition-colors"
              >
                <MonitorPlay className="w-5 h-5" />
                <span className="hidden sm:inline">Atril</span>
              </button>
              <IconButton label={isMuted ? 'Activar mi click' : 'Silenciar mi click'} onClick={() => setMuted(!isMuted)}>
                {isMuted ? <VolumeX className="w-5 h-5 text-rose-300" /> : <Volume2 className="w-5 h-5" />}
              </IconButton>
              <IconButton label="Ajustes de audio" onClick={() => setIsAudioModalOpen(true)}>
                <Settings2 className="w-5 h-5" />
              </IconButton>
              <div className="relative">
                <IconButton label="Más opciones" active={isMenuOpen} onClick={() => setIsMenuOpen((v) => !v)}>
                  <MoreHorizontal className="w-5 h-5" />
                </IconButton>
                {isMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsMenuOpen(false)} />
                    <div className="absolute right-0 top-12 z-50 w-60 p-1.5 rounded-2xl bg-surface-2 shadow-2xl ring-1 ring-white/5 animate-fade-in">
                      {!isOfflineMode && (
                        <MenuItem
                          icon={<QrCode className="w-4 h-4" />}
                          onClick={() => {
                            setIsMenuOpen(false);
                            setIsShareModalOpen(true);
                          }}
                        >
                          Invitar a la banda
                        </MenuItem>
                      )}
                      <MenuItem
                        icon={<Smartphone className="w-4 h-4" />}
                        onClick={() => {
                          setIsMenuOpen(false);
                          setIsLockScreenModalOpen(true);
                        }}
                      >
                        Usar con el celular bloqueado
                      </MenuItem>
                      {!isInstalled && (
                        <MenuItem icon={<Download className="w-4 h-4" />} onClick={handleInstallApp}>
                          Instalar app
                        </MenuItem>
                      )}
                      <div className="my-1 h-px bg-line" />
                      <MenuItem icon={<LogOut className="w-4 h-4" />} onClick={handleLeave} danger>
                        {isOfflineMode ? 'Salir de la práctica' : 'Salir de la sala'}
                      </MenuItem>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>
        {room && (
          <div className="sm:hidden flex items-center justify-between px-4 pb-3 text-xs text-neutral-400">
            {isOfflineMode ? (
              <span className="inline-flex items-center gap-2"><WifiOff className="w-3.5 h-3.5" /> Práctica local</span>
            ) : (
              <button type="button" onClick={() => setIsShareModalOpen(true)} className="inline-flex items-center gap-2" aria-label={`Invitar a la sala ${room.roomId}`}>
                <span className={cx('w-1.5 h-1.5 rounded-full', isConnected ? 'bg-accent' : 'bg-brand animate-pulse')} />
                Sala <span className="text-ivory tracking-widest">{room.roomId}</span><QrCode className="w-3.5 h-3.5" />
              </button>
            )}
            {!isOfflineMode && <span className="tabular-nums">Red · {latencyMs} ms</span>}
          </div>
        )}
      </header>

      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 py-2 text-xs text-amber-200 bg-amber-500/10">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Reconectando con la sala… el click sigue sonando.
        </div>
      )}

      {needsAudioTap && (
        <button
          type="button"
          onClick={() => {
            audioEngine.unlockAudio();
          }}
          className="flex items-center justify-center gap-2 py-3 text-sm font-medium text-black bg-white"
        >
          <Volume2 className="w-4 h-4" />
          Tocá acá para activar el sonido
        </button>
      )}

      {/* Active cue: large and on top so it is readable mid-song */}
      {activeCue && (
        <div className="fixed top-20 left-1/2 z-[70] w-[calc(100%-2rem)] max-w-md animate-slide-down" role="status" aria-live="assertive">
          <div
            className={cx(
              'px-5 py-4 rounded-3xl shadow-2xl',
              activeCue.type === 'stop' ? 'bg-rose-500 text-white' : 'bg-white text-black'
            )}
          >
            <div className="text-xs opacity-60">{activeCue.senderName}</div>
            <div className="text-xl font-medium leading-snug">{activeCue.text}</div>
          </div>
        </div>
      )}

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 lg:px-8 py-5 lg:py-8 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
        {room ? (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 lg:gap-6 items-start">
            <div className="lg:col-span-7 flex flex-col gap-4">
              <LatencyControl key={room.roomId} value={bluetoothOffsetMs} onChange={setBluetoothOffset} active={!isAudioModalOpen && !isStageOpen} />

              <BeatVisualizer
                isPlaying={room.isPlaying}
                timeSignature={room.timeSignature}
                accentPattern={room.accentPattern}
                canEdit={isHost}
                onToggleAccent={toggleAccentAt}
                fullScreenFlash={fullScreenFlash}
                onToggleFullScreenFlash={handleToggleFlash}
              />

              <TempoControls
                bpm={room.bpm}
                isPlaying={room.isPlaying}
                canControl={isHost}
                controllerName={hostMember?.name ?? null}
                onTogglePlay={togglePlay}
                onSetBpm={setBpm}
                onAdjustBpm={adjustBpm}
                onTapTempo={tapTempo}
                countInBars={room.countInBars}
                onSetCountInBars={setCountInBars}
                currentSong={currentSong}
                currentIndex={currentSongIndex}
                setlistCount={room.setlist.length}
                onNextSong={handleNextSong}
                onPrevSong={handlePrevSong}
                onSaveBpmToSong={handleSaveBpmToSong}
              />

              {isHost && (
                <SignatureControls
                  timeSignature={room.timeSignature}
                  subdivision={room.subdivision}
                  onSetTimeSignature={setTimeSignature}
                  onSetSubdivision={setSubdivision}
                />
              )}
            </div>

            <div className="lg:col-span-5 flex flex-col gap-4 lg:sticky lg:top-24">
              <Segmented
                value={activeTab}
                onChange={setActiveTab}
                options={
                  isOfflineMode
                    ? [
                        { value: 'setlist', label: 'Setlist' },
                        { value: 'tuner', label: 'Afinador' },
                      ]
                    : [
                        { value: 'setlist', label: 'Setlist' },
                        { value: 'band', label: `Banda · ${room.members.length}` },
                        { value: 'cues', label: 'Avisos' },
                        { value: 'tuner', label: 'Afinador' },
                      ]
                }
              />

              {activeTab === 'setlist' && (
                <SetlistManager
                  room={room}
                  onSelectSong={selectSong}
                  onUpdateSetlist={updateSetlist}
                  isHost={isHost}
                  isOffline={isOfflineMode}
                />
              )}

              {!isOfflineMode && activeTab === 'band' && (
                <MusiciansList
                  members={room.members}
                  myId={myId}
                  isHost={isHost}
                  onUpdateProfile={updateProfile}
                  onSetHost={setHost}
                  onOpenShareModal={() => setIsShareModalOpen(true)}
                />
              )}

              {!isOfflineMode && activeTab === 'cues' && <RehearsalCues recentCues={room.recentCues} onSendCue={sendCue} />}

              {activeTab === 'tuner' && <TunerPanel isPlaying={room.isPlaying} />}
            </div>
          </div>
        ) : (
          isConnecting && (
            <div className="flex items-center justify-center py-24 text-neutral-500">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          )
        )}
      </main>

      {room && (
        <StageMode
          open={isStageOpen}
          onClose={closeStage}
          isPlaying={room.isPlaying}
          bpm={room.bpm}
          timeSignature={room.timeSignature}
          accentPattern={room.accentPattern}
          currentSong={currentSong}
          nextSong={
            room.setlist.length > 1 && currentSongIndex >= 0
              ? room.setlist[(currentSongIndex + 1) % room.setlist.length]
              : undefined
          }
          currentIndex={currentSongIndex}
          setlistCount={room.setlist.length}
          canControl={isHost}
          controllerName={hostMember?.name ?? null}
          onTogglePlay={togglePlay}
          onNextSong={handleNextSong}
          onPrevSong={handlePrevSong}
        />
      )}

      <JoinRoomModal
        isOpen={isJoinOpen}
        initialRoomId={urlRoomId}
        onJoin={joinRoom}
        onStartOffline={startOfflineMode}
        onOpenInstallModal={handleInstallApp}
        isConnecting={isConnecting}
        isInstalled={isInstalled}
        error={joinError}
      />

      <LocalAudioSettingsModal
        isOpen={isAudioModalOpen}
        onClose={() => setIsAudioModalOpen(false)}
        latencyMs={latencyMs}
        onRecalibrateClock={recalibrateClock}
        fineOffsetMs={bluetoothOffsetMs}
        onChangeOffset={setBluetoothOffset}
        isMuted={isMuted}
        onSetMuted={setMuted}
        keepScreenAwake={keepScreenAwake}
        onToggleKeepScreenAwake={handleToggleKeepScreenAwake}
        isOffline={isOfflineMode}
      />

      {room && !isOfflineMode && (
        <ShareRoomModal isOpen={isShareModalOpen} onClose={() => setIsShareModalOpen(false)} roomId={room.roomId} />
      )}

      <LockScreenGuideModal
        isOpen={isLockScreenModalOpen}
        onClose={() => setIsLockScreenModalOpen(false)}
        isHost={isHost}
        keepScreenAwake={keepScreenAwake}
        onToggleKeepScreenAwake={handleToggleKeepScreenAwake}
      />

      <DownloadAppModal
        isOpen={isDownloadModalOpen}
        onClose={() => setIsDownloadModalOpen(false)}
        onInstallNative={async () => {
          await install();
          setIsDownloadModalOpen(false);
        }}
        canPromptNative={canPromptNative}
        isIOS={isIOS}
        isInstalled={isInstalled}
      />
    </div>
  );
}

const MenuItem: React.FC<{ icon: React.ReactNode; onClick: () => void; children: React.ReactNode; danger?: boolean }> = ({
  icon,
  onClick,
  children,
  danger,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={cx(
      'w-full flex items-center gap-3 h-11 px-3 rounded-xl text-sm text-left transition-colors',
      danger ? 'text-rose-300 hover:bg-rose-500/10' : 'text-neutral-200 hover:bg-surface-3'
    )}
  >
    <span className="text-neutral-500">{icon}</span>
    {children}
  </button>
);
