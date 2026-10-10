import { useState, useEffect, useRef, useCallback } from 'react';
import {
  RoomState,
  PlaybackState,
  WSClientMessage,
  WSServerMessage,
  InstrumentType,
  Subdivision,
  TimeSignature,
  SongItem,
  NamedSetlist,
  RehearsalCue,
  MIN_BPM,
  MAX_BPM,
  defaultAccentPattern,
} from '../types/metronome';
import { audioEngine } from '../utils/audioEngine';
import { monotonicNowMs, nextBarStart } from '../utils/timing';
import { getClientId } from '../utils/clientId';

export interface UseSyncBeatReturn {
  isConnected: boolean;
  isConnecting: boolean;
  isOfflineMode: boolean;
  room: RoomState | null;
  myId: string;
  latencyMs: number;
  bluetoothOffsetMs: number;
  joinError: string | null;
  joinRoom: (roomId: string, name: string, instrument: InstrumentType, initialSetlist?: NamedSetlist) => void;
  leaveRoom: () => void;
  startOfflineMode: (setlist?: NamedSetlist) => void;
  recalibrateClock: () => void;
  setBluetoothOffset: (offsetMs: number) => void;
  togglePlay: () => void;
  setBpm: (bpm: number) => void;
  adjustBpm: (delta: number) => void;
  tapTempo: () => void;
  setTimeSignature: (ts: TimeSignature) => void;
  setSubdivision: (sub: Subdivision) => void;
  toggleAccentAt: (index: number) => void;
  setCountInBars: (bars: number) => void;
  sendCue: (text: string, cueType?: RehearsalCue['type']) => void;
  selectSong: (songId: string) => void;
  updateSetlist: (setlist: SongItem[], meta?: { id: string | null; name: string | null }) => void;
  updateProfile: (name: string, instrument: InstrumentType) => void;
  setHost: (memberId: string) => void;
  activeCue: RehearsalCue | null;
}

const OFFLINE_ID = 'local-musician';
// Matches the server's lead: the audio clock needs about half a second after starting before it
// reports its latency honestly, and the first beat must land after that. See PLAY_LEAD_MS.
const OFFLINE_PLAY_LEAD_MS = 900;
const OFFLINE_CHANGE_LEAD_MS = 200;

function pickPlayback(state: PlaybackState): PlaybackState {
  return {
    isPlaying: state.isPlaying,
    startServerTime: state.startServerTime,
    countInBeats: state.countInBeats || 0,
    bpm: state.bpm,
    timeSignature: state.timeSignature,
    subdivision: state.subdivision,
    accentPattern: state.accentPattern,
  };
}

export function useSyncBeat(): UseSyncBeatReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isOfflineMode, setIsOfflineMode] = useState(false);
  const [room, setRoom] = useState<RoomState | null>(null);
  const [myId, setMyId] = useState<string>(OFFLINE_ID);
  const [latencyMs, setLatencyMs] = useState<number>(0);
  const [bluetoothOffsetMs, setBluetoothOffsetState] = useState<number>(() => audioEngine.getBluetoothOffset());
  const [activeCue, setActiveCue] = useState<RehearsalCue | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const myIdRef = useRef<string>(OFFLINE_ID);
  const pingSamplesRef = useRef<{ offset: number; rtt: number }[]>([]);
  const tapTimesRef = useRef<number[]>([]);
  const pingIntervalRef = useRef<number | null>(null);
  const lastJoinInfoRef = useRef<{ roomId: string; name: string; instrument: InstrumentType; initialSetlist?: NamedSetlist } | null>(null);
  const isDeliberateDisconnectRef = useRef<boolean>(false);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const cueTimerRef = useRef<number | null>(null);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  const showCue = useCallback((cue: RehearsalCue, durationMs = 4500) => {
    setActiveCue(cue);
    if (cueTimerRef.current) clearTimeout(cueTimerRef.current);
    cueTimerRef.current = window.setTimeout(() => {
      setActiveCue((curr) => (curr?.id === cue.id ? null : curr));
    }, durationMs);
  }, []);

  const setBluetoothOffset = useCallback((offset: number) => {
    audioEngine.setBluetoothOffset(offset);
    setBluetoothOffsetState(audioEngine.getBluetoothOffset());
  }, []);

  const send = useCallback((msg: WSClientMessage) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // NTP-style ping on the monotonic clock
  const sendPing = useCallback(() => {
    send({ type: 'ping', clientTime: monotonicNowMs() });
  }, [send]);

  const recalibrateClock = useCallback(() => {
    pingSamplesRef.current = [];
    for (let i = 0; i < 8; i++) {
      setTimeout(sendPing, i * 60);
    }
  }, [sendPing]);

  // ---------------------------------------------------------------------------
  // Offline (local) mode applies the same timing rules the server uses
  // ---------------------------------------------------------------------------

  const updateOffline = useCallback((updater: (prev: RoomState) => RoomState) => {
    const prev = roomRef.current;
    if (!prev) return;
    const next = updater(prev);
    roomRef.current = next;
    setRoom(next);
    audioEngine.setPlayback(pickPlayback(next));
  }, []);

  /** For tempo / meter / song changes while playing: land on the next bar line. */
  const offlineRebase = (prev: RoomState): Partial<RoomState> => {
    if (!prev.isPlaying) return {};
    const next = nextBarStart(prev, audioEngine.serverNow(), OFFLINE_CHANGE_LEAD_MS);
    if (next === null || next === prev.startServerTime) return {};
    return { startServerTime: next, countInBeats: 0 };
  };

  const startOfflineMode = useCallback((setlist?: NamedSetlist) => {
    isDeliberateDisconnectRef.current = true;
    lastJoinInfoRef.current = null;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setIsConnected(false);
    setIsConnecting(false);
    setIsOfflineMode(true);
    setJoinError(null);
    setLatencyMs(0);
    setMyId(OFFLINE_ID);
    myIdRef.current = OFFLINE_ID;
    audioEngine.setServerTimeOffset(0);
    audioEngine.stop();

    const offlineRoom: RoomState = {
      roomId: 'OFFLINE',
      roomName: 'Práctica local',
      bpm: 120,
      isPlaying: false,
      startServerTime: null,
      countInBeats: 0,
      timeSignature: { numerator: 4, denominator: 4 },
      subdivision: '1',
      accentPattern: defaultAccentPattern(4),
      countInBars: 1,
      leaderId: OFFLINE_ID,
      currentSongId: null,
      setlist: setlist?.songs ?? [],
      setlistId: setlist?.id ?? null,
      setlistName: setlist?.name ?? null,
      members: [
        {
          id: OFFLINE_ID,
          name: 'Vos',
          instrument: 'drums',
          isLeader: true,
          pingMs: 0,
          color: '#2dd4bf',
          joinedAt: Date.now(),
        },
      ],
      recentCues: [],
    };

    const firstSong = offlineRoom.setlist[0];
    if (firstSong) {
      offlineRoom.currentSongId = firstSong.id;
      offlineRoom.bpm = firstSong.bpm;
      offlineRoom.timeSignature = firstSong.timeSignature;
      offlineRoom.subdivision = firstSong.subdivision;
      offlineRoom.accentPattern = firstSong.accentPattern;
    }
    roomRef.current = offlineRoom;
    setRoom(offlineRoom);
  }, []);

  // ---------------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------------

  const connect = useCallback((roomId: string, name: string, instrument: InstrumentType, initialSetlist?: NamedSetlist) => {
    if (socketRef.current) {
      const old = socketRef.current;
      old.onclose = null;
      old.close();
    }

    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    lastJoinInfoRef.current = { roomId, name, instrument, initialSetlist };
    isDeliberateDisconnectRef.current = false;
    setIsConnecting(true);

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
    socketRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setIsConnected(true);
      setIsConnecting(false);

      send({ type: 'join', roomId, name, instrument, clientId: getClientId(), ...(initialSetlist ? { initialSetlist } : {}) });

      // Initial burst for a quick clock estimate, then periodic drift correction
      pingSamplesRef.current = [];
      for (let i = 0; i < 6; i++) {
        setTimeout(sendPing, i * 60);
      }
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = window.setInterval(sendPing, 5000);
    };

    ws.onclose = () => {
      if (socketRef.current !== ws) return;
      setIsConnected(false);
      setIsConnecting(false);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);

      // Phones drop sockets when the screen locks: reconnect with backoff unless the user left
      if (!isDeliberateDisconnectRef.current && lastJoinInfoRef.current) {
        const attempt = reconnectAttemptsRef.current++;
        const delay = Math.min(8000, 1000 * 2 ** attempt);
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(() => {
          const info = lastJoinInfoRef.current;
          if (!isDeliberateDisconnectRef.current && info) {
            connect(info.roomId, info.name, info.instrument, info.initialSetlist);
          }
        }, delay);
      }
    };

    ws.onerror = () => {
      setIsConnecting(false);
    };

    ws.onmessage = (event) => {
      let msg: WSServerMessage;
      try {
        msg = JSON.parse(event.data) as WSServerMessage;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'pong': {
          const receivedAt = monotonicNowMs();
          const rtt = receivedAt - msg.clientTime;
          if (rtt < 0 || rtt > 10_000) break;
          const offset = msg.serverTime + rtt / 2 - receivedAt;
          const oneWay = Math.round(rtt / 2);
          setLatencyMs((prev) => (Math.abs(prev - oneWay) >= 4 ? oneWay : prev));

          pingSamplesRef.current.push({ offset, rtt });
          if (pingSamplesRef.current.length > 20) pingSamplesRef.current.shift();

          if (pingSamplesRef.current.length % 3 === 0) {
            send({ type: 'report_ping', pingMs: oneWay });
          }

          // Samples with the lowest RTT suffered the least queuing, so trust those
          const best = [...pingSamplesRef.current]
            .sort((a, b) => a.rtt - b.rtt)
            .slice(0, Math.max(1, Math.min(4, Math.ceil(pingSamplesRef.current.length * 0.4))));
          audioEngine.setServerTimeOffset(Math.round(best.reduce((sum, s) => sum + s.offset, 0) / best.length));
          break;
        }

        case 'room_state': {
          setRoom(msg.state);
          roomRef.current = msg.state;
          setJoinError(null);
          if (msg.yourId) {
            setMyId(msg.yourId);
            myIdRef.current = msg.yourId;
            if (lastJoinInfoRef.current) lastJoinInfoRef.current.initialSetlist = undefined;
          }
          audioEngine.setPlayback(pickPlayback(msg.state));
          break;
        }

        case 'playback_state': {
          const playback = pickPlayback(msg);
          setRoom((prev) => (prev ? { ...prev, ...playback } : null));
          if (playback.isPlaying) audioEngine.unlockAudio();
          audioEngine.setPlayback(playback);
          break;
        }

        case 'members_update': {
          setRoom((prev) => (prev ? { ...prev, members: msg.members } : null));
          // Remember accepted profile changes so a reconnect rejoins with them
          const me = msg.members.find((m) => m.id === myIdRef.current);
          if (me && lastJoinInfoRef.current) {
            lastJoinInfoRef.current = { ...lastJoinInfoRef.current, name: me.name, instrument: me.instrument };
          }
          break;
        }

        case 'cue_broadcast': {
          showCue(msg.cue);
          setRoom((prev) =>
            prev ? { ...prev, recentCues: [msg.cue, ...prev.recentCues].slice(0, 20) } : null
          );
          break;
        }

        case 'song_selected': {
          setRoom((prev) => (prev ? { ...prev, currentSongId: msg.song.id } : null));
          break;
        }

        case 'error': {
          if (!roomRef.current) {
            // Rejected before entering the room (e.g. drums already taken): back to the join screen
            setJoinError(msg.message);
            isDeliberateDisconnectRef.current = true;
            lastJoinInfoRef.current = null;
            ws.close();
            break;
          }
          showCue({
            id: 'err-' + Date.now(),
            senderName: 'Atención',
            text: msg.message,
            timestamp: Date.now(),
            type: 'stop',
          });
          break;
        }
      }
    };
  }, [send, sendPing, showCue]);

  // Recover after the phone wakes up or the network comes back
  useEffect(() => {
    const handleWakeUp = () => {
      audioEngine.unlockAudio();
      const socket = socketRef.current;
      const info = lastJoinInfoRef.current;
      if (!isDeliberateDisconnectRef.current && info && (!socket || socket.readyState >= WebSocket.CLOSING)) {
        reconnectAttemptsRef.current = 0;
        connect(info.roomId, info.name, info.instrument, info.initialSetlist);
      } else if (socket?.readyState === WebSocket.OPEN) {
        recalibrateClock();
      }
    };

    const handleVis = () => {
      if (document.visibilityState === 'visible') handleWakeUp();
    };

    document.addEventListener('visibilitychange', handleVis);
    window.addEventListener('pageshow', handleWakeUp);
    window.addEventListener('online', handleWakeUp);

    return () => {
      document.removeEventListener('visibilitychange', handleVis);
      window.removeEventListener('pageshow', handleWakeUp);
      window.removeEventListener('online', handleWakeUp);
    };
  }, [connect, recalibrateClock]);

  useEffect(() => {
    return () => {
      isDeliberateDisconnectRef.current = true;
      socketRef.current?.close();
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      audioEngine.stop();
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  const joinRoom = useCallback(
    (roomId: string, name: string, instrument: InstrumentType, initialSetlist?: NamedSetlist) => {
      setIsOfflineMode(false);
      setJoinError(null);
      setRoom(null);
      roomRef.current = null;
      audioEngine.stop();
      audioEngine.unlockAudio();
      reconnectAttemptsRef.current = 0;
      connect(roomId, name, instrument, initialSetlist);
    },
    [connect]
  );

  const leaveRoom = useCallback(() => {
    isDeliberateDisconnectRef.current = true;
    lastJoinInfoRef.current = null;
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    audioEngine.stop();
    roomRef.current = null;
    setRoom(null);
    setIsConnected(false);
    setIsOfflineMode(false);
  }, []);

  const togglePlay = useCallback(() => {
    const current = roomRef.current;
    if (!current) return;
    audioEngine.unlockAudio(); // Must run inside the user gesture on iOS

    if (isOfflineMode) {
      updateOffline((prev) =>
        prev.isPlaying
          ? { ...prev, isPlaying: false, startServerTime: null, countInBeats: 0 }
          : {
              ...prev,
              isPlaying: true,
              startServerTime: audioEngine.serverNow() + OFFLINE_PLAY_LEAD_MS,
              countInBeats: prev.countInBars * prev.timeSignature.numerator,
            }
      );
      return;
    }

    send({ type: current.isPlaying ? 'stop' : 'play' });
  }, [isOfflineMode, send, updateOffline]);

  const setBpm = useCallback(
    (bpm: number) => {
      const clamped = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
      if (isOfflineMode) {
        updateOffline((prev) => (prev.bpm === clamped ? prev : { ...prev, ...offlineRebase(prev), bpm: clamped }));
        return;
      }
      send({ type: 'setBpm', bpm: clamped });
    },
    [isOfflineMode, send, updateOffline]
  );

  const adjustBpm = useCallback(
    (delta: number) => {
      const current = roomRef.current;
      if (current) setBpm(current.bpm + delta);
    },
    [setBpm]
  );

  const tapTempo = useCallback(() => {
    const now = performance.now();
    const taps = tapTimesRef.current;

    // Reset if last tap was more than 2.5 seconds ago
    if (taps.length > 0 && now - taps[taps.length - 1] > 2500) {
      taps.length = 0;
    }
    taps.push(now);
    if (taps.length > 6) taps.shift();

    if (taps.length >= 3) {
      const avgInterval = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / avgInterval);
    }
  }, [setBpm]);

  const setTimeSignature = useCallback(
    (ts: TimeSignature) => {
      if (isOfflineMode) {
        updateOffline((prev) => ({
          ...prev,
          ...offlineRebase(prev),
          timeSignature: ts,
          accentPattern: defaultAccentPattern(ts.numerator),
        }));
        return;
      }
      send({ type: 'setTimeSignature', timeSignature: ts });
    },
    [isOfflineMode, send, updateOffline]
  );

  const setSubdivision = useCallback(
    (sub: Subdivision) => {
      if (isOfflineMode) {
        updateOffline((prev) => ({ ...prev, subdivision: sub }));
        return;
      }
      send({ type: 'setSubdivision', subdivision: sub });
    },
    [isOfflineMode, send, updateOffline]
  );

  const toggleAccentAt = useCallback(
    (index: number) => {
      const current = roomRef.current;
      if (!current) return;
      const pattern = [...current.accentPattern];
      // Cycle: 2 (accent) -> 1 (normal) -> 0 (mute) -> 2
      const currentVal = pattern[index] ?? 1;
      pattern[index] = currentVal === 2 ? 1 : currentVal === 1 ? 0 : 2;

      if (isOfflineMode) {
        updateOffline((prev) => ({ ...prev, accentPattern: pattern }));
        return;
      }
      send({ type: 'setAccentPattern', accentPattern: pattern });
    },
    [isOfflineMode, send, updateOffline]
  );

  const setCountInBars = useCallback(
    (bars: number) => {
      if (isOfflineMode) {
        updateOffline((prev) => ({ ...prev, countInBars: bars }));
        return;
      }
      send({ type: 'setCountInBars', countInBars: bars });
    },
    [isOfflineMode, send, updateOffline]
  );

  const sendCue = useCallback(
    (text: string, cueType: RehearsalCue['type'] = 'custom') => {
      if (isOfflineMode) {
        const cue: RehearsalCue = { id: 'cue-' + Date.now(), senderName: 'Vos', text, timestamp: Date.now(), type: cueType };
        showCue(cue, 4000);
        setRoom((prev) => (prev ? { ...prev, recentCues: [cue, ...prev.recentCues].slice(0, 20) } : null));
        return;
      }
      send({ type: 'sendCue', text, cueType });
    },
    [isOfflineMode, send, showCue]
  );

  const selectSong = useCallback(
    (songId: string) => {
      if (isOfflineMode) {
        updateOffline((prev) => {
          const song = prev.setlist.find((s) => s.id === songId);
          if (!song) return prev;
          return {
            ...prev,
            ...offlineRebase(prev),
            currentSongId: song.id,
            bpm: song.bpm,
            timeSignature: song.timeSignature,
            subdivision: song.subdivision,
            accentPattern: song.accentPattern,
          };
        });
        return;
      }
      send({ type: 'selectSong', songId });
    },
    [isOfflineMode, send, updateOffline]
  );

  const updateSetlist = useCallback(
    (setlist: SongItem[], meta?: { id: string | null; name: string | null }) => {
      if (isOfflineMode) {
        // Same rules as the server: keep the selected song, or take the first one while stopped
        updateOffline((prev) => {
          const current = setlist.find((s) => s.id === prev.currentSongId) ?? (prev.isPlaying ? undefined : setlist[0]);
          return {
            ...prev,
            setlist,
            setlistId: setlist.length ? (meta ? meta.id : prev.setlistId) : null,
            setlistName: setlist.length ? (meta ? meta.name : prev.setlistName) : null,
            currentSongId: current?.id ?? null,
            ...(current && !prev.isPlaying
              ? {
                  bpm: current.bpm,
                  timeSignature: current.timeSignature,
                  subdivision: current.subdivision,
                  accentPattern: current.accentPattern,
                }
              : {}),
          };
        });
        return;
      }
      send({ type: 'updateSetlist', setlist, ...(meta ? { setlistId: meta.id, setlistName: meta.name } : {}) });
    },
    [isOfflineMode, send, updateOffline]
  );

  const updateProfile = useCallback(
    (name: string, instrument: InstrumentType) => {
      send({ type: 'updateMember', name, instrument });
    },
    [send]
  );

  /** Hands the room over to another musician; the server only honours it from the current host. */
  const setHost = useCallback(
    (memberId: string) => {
      send({ type: 'setHost', memberId });
    },
    [send]
  );

  return {
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
    setHost,
    updateProfile,
    activeCue,
  };
}
