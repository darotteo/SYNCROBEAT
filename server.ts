import express from 'express';
import http from 'http';
import path from 'path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import {
  RoomState,
  WSClientMessage,
  WSServerMessage,
  MemberInfo,
  SongItem,
  RehearsalCue,
  TimeSignature,
  Subdivision,
  InstrumentType,
  INSTRUMENT_TYPES,
  CUE_TYPES,
  MIN_BPM,
  MAX_BPM,
  MAX_SETLIST_SONGS,
  defaultAccentPattern,
} from './src/types/metronome.ts';
import { nextBarStart } from './src/utils/timing.ts';

const isProduction = process.env.NODE_ENV === 'production' || process.argv.includes('--prod');
const PORT = Number(process.env.PORT) || 3000;

// Timing
// Delay before the first click. It covers both the time every client needs to receive "play" and
// the time a phone's audio hardware needs to report its output latency honestly after starting:
// measured on Chrome, the first readings are up to ~110 ms out and take about half a second to
// settle. Schedule the first beat before that and it lands tens of ms off the grid, which cannot be
// corrected afterwards because the beat is already due.
const PLAY_LEAD_MS = 900;
const CHANGE_LEAD_MS = 350; // Minimum notice before a tempo / song change takes effect

// Limits & housekeeping
const HEARTBEAT_INTERVAL_MS = 15_000;
const EMPTY_ROOM_TTL_MS = 30 * 60_000;
const RATE_BUCKET_SIZE = 40;
const RATE_REFILL_PER_SEC = 20;
const MAX_MESSAGE_BYTES = 256 * 1024;
const FREE_ROOM_MEMBERS = 2;
// Temporary server-side grants for testing only. Store entitlements must replace this before release.
const betaProRooms = new Set(process.env.SYNCROBEAT_RELEASE_CHANNEL === 'beta'
  ? (process.env.BETA_PRO_ROOM_CODES || '').split(',').map((id) => sanitizeRoomId(id)).filter(Boolean) : []);
const nativeOrigins = new Set((process.env.NATIVE_APP_ORIGINS || 'https://localhost,capacitor://localhost').split(',').map((s) => s.trim()));

const app = express();
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && nativeOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  }
  next();
});
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

// Fallback WebSocket server for dev tooling (e.g. Vite HMR client) so stray upgrades never error
const fallbackWss = new WebSocketServer({ noServer: true });
fallbackWss.on('connection', (ws) => {
  ws.on('message', () => {});
  ws.on('error', () => {});
  try {
    ws.send(JSON.stringify({ type: 'connected' }));
  } catch {}
});

server.on('upgrade', (request, socket, head) => {
  try {
    const { pathname } = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
    if (pathname.startsWith('/api/ws')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      fallbackWss.handleUpgrade(request, socket, head, (ws) => {
        fallbackWss.emit('connection', ws, request);
      });
    }
  } catch {
    socket.destroy();
  }
});

// ---------------------------------------------------------------------------
// Input sanitizing: everything coming from a socket is untrusted
// ---------------------------------------------------------------------------

const SUBDIVISIONS: Subdivision[] = ['1', '2', '3', '4'];
const DENOMINATORS = [2, 4, 8, 16];

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function clampInt(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeRoomId(value: unknown): string {
  return cleanText(value, 20).toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

function sanitizeClientId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

function sanitizeInstrument(value: unknown): InstrumentType | null {
  return INSTRUMENT_TYPES.includes(value as InstrumentType) ? (value as InstrumentType) : null;
}

function sanitizeSubdivision(value: unknown): Subdivision | null {
  return SUBDIVISIONS.includes(value as Subdivision) ? (value as Subdivision) : null;
}

function sanitizeTimeSignature(value: unknown): TimeSignature | null {
  if (!value || typeof value !== 'object') return null;
  const { numerator, denominator } = value as Record<string, unknown>;
  const num = clampInt(numerator, 1, 16);
  const den = Number(denominator);
  if (num === null || !DENOMINATORS.includes(den)) return null;
  return { numerator: num, denominator: den };
}

function sanitizeAccentPattern(value: unknown, numerator: number): number[] {
  if (!Array.isArray(value) || value.length !== numerator) return defaultAccentPattern(numerator);
  return value.map((v) => clampInt(v, 0, 2) ?? 1);
}

function sanitizeSong(value: unknown): SongItem | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const title = cleanText(v.title, 80);
  const bpm = clampInt(v.bpm, MIN_BPM, MAX_BPM);
  if (!title || bpm === null) return null;
  const timeSignature = sanitizeTimeSignature(v.timeSignature) ?? { numerator: 4, denominator: 4 };
  const notes = cleanText(v.notes, 160);
  return {
    id: cleanText(v.id, 64) || 'song-' + Math.random().toString(36).slice(2, 10),
    title,
    bpm,
    timeSignature,
    subdivision: sanitizeSubdivision(v.subdivision) ?? '1',
    accentPattern: sanitizeAccentPattern(v.accentPattern, timeSignature.numerator),
    ...(notes ? { notes } : {}),
  };
}

function sanitizeSetlist(value: unknown): SongItem[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const songs: SongItem[] = [];
  // Junk entries do not count towards the limit; the message size already bounds the loop
  for (const raw of value) {
    if (songs.length >= MAX_SETLIST_SONGS) break;
    const song = sanitizeSong(raw);
    if (!song) continue;
    if (seen.has(song.id)) song.id = song.id + '-' + Math.random().toString(36).slice(2, 6);
    seen.add(song.id);
    songs.push(song);
  }
  return songs;
}

// ---------------------------------------------------------------------------
// Rooms & clients
// ---------------------------------------------------------------------------

const rooms = new Map<string, RoomState>();
const roomEmptySince = new Map<string, number>();
const deviceSessions = new Map<string, { token: string; lastSeen: number }>();

function validDeviceToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(actual) || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function roomAccess(roomId: string) {
  const pro = betaProRooms.has(roomId);
  return { plan: pro ? 'pro' as const : 'free' as const, memberLimit: pro ? null : FREE_ROOM_MEMBERS };
}

interface ClientContext {
  authenticated: boolean;
  id: string; // Stable per device (sent by the client), so a reconnect reclaims the same seat
  ws: WebSocket;
  roomId: string | null;
  name: string;
  instrument: InstrumentType;
  color: string;
  isAlive: boolean;
  replaced: boolean; // Set when a newer socket of the same device took over this seat
  tokens: number;
  lastRefill: number;
  warnedRateLimit: boolean;
}

const clients = new Map<WebSocket, ClientContext>();

const AVATAR_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#e11d48'];

function getRandomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function getOrCreateRoom(roomId: string): RoomState {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      ...roomAccess(roomId),
      roomId,
      roomName: `Sala ${roomId}`,
      bpm: 120,
      isPlaying: false,
      startServerTime: null,
      countInBeats: 0,
      timeSignature: { numerator: 4, denominator: 4 },
      subdivision: '1',
      accentPattern: defaultAccentPattern(4),
      countInBars: 1,
      leaderId: null,
      currentSongId: null,
      setlist: [],
      setlistId: null,
      setlistName: null,
      members: [],
      recentCues: [],
    };
    rooms.set(roomId, room);
  }
  roomEmptySince.delete(roomId);
  return room;
}

/**
 * Replaces the room setlist. `meta` names the saved setlist it came from; leave it undefined for
 * plain edits so the room keeps its name. While stopped, the selected song (or the first one when
 * the selection disappeared) is applied straight away.
 */
function applySetlist(room: RoomState, setlist: SongItem[], meta?: { id: string | null; name: string | null }) {
  room.setlist = setlist;
  if (meta) {
    room.setlistId = meta.id;
    room.setlistName = meta.name;
  }
  if (setlist.length === 0) {
    room.setlistId = null;
    room.setlistName = null;
  }

  const current = setlist.find((s) => s.id === room.currentSongId) ?? (room.isPlaying ? undefined : setlist[0]);
  room.currentSongId = current?.id ?? null;
  if (current && !room.isPlaying) {
    room.bpm = current.bpm;
    room.timeSignature = current.timeSignature;
    room.subdivision = current.subdivision;
    room.accentPattern = current.accentPattern;
  }
}

function sanitizeSetlistMeta(id: unknown, name: unknown): { id: string | null; name: string | null } {
  return { id: cleanText(id, 64) || null, name: cleanText(name, 80) || null };
}

function send(ws: WebSocket, message: WSServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function broadcastToRoom(roomId: string, message: WSServerMessage, except?: WebSocket) {
  const json = JSON.stringify(message);
  for (const [ws, ctx] of clients.entries()) {
    if (ctx.roomId === roomId && ws !== except && ws.readyState === WebSocket.OPEN) {
      ws.send(json);
    }
  }
}

function broadcastPlayback(room: RoomState) {
  broadcastToRoom(room.roomId, {
    type: 'playback_state',
    isPlaying: room.isPlaying,
    startServerTime: room.startServerTime,
    countInBeats: room.countInBeats,
    bpm: room.bpm,
    timeSignature: room.timeSignature,
    subdivision: room.subdivision,
    accentPattern: room.accentPattern,
  });
}

function broadcastRoomState(room: RoomState, except?: WebSocket) {
  broadcastToRoom(room.roomId, { type: 'room_state', state: room, yourId: '' }, except);
}

/**
 * Re-anchors a running metronome so a tempo / meter / song change lands on the next bar line
 * (in the old tempo) that is at least CHANGE_LEAD_MS away. Every client keeps clicking the old
 * tempo until that instant, so the "1" never jumps and nobody misses the first click.
 */
function rebaseToNextBar(room: RoomState) {
  if (!room.isPlaying) return;
  const next = nextBarStart(room, Date.now(), CHANGE_LEAD_MS);
  // Unchanged anchor means playback has not started yet: the new values simply apply from the start
  if (next === null || next === room.startServerTime) return;
  room.startServerTime = next;
  room.countInBeats = 0;
}

function removeFromRoom(ctx: ClientContext) {
  if (!ctx.roomId) return;
  const room = rooms.get(ctx.roomId);
  const roomId = ctx.roomId;
  ctx.roomId = null;
  if (!room) return;

  room.members = room.members.filter((m) => m.id !== ctx.id);

  if (room.leaderId === ctx.id) {
    room.leaderId = room.members[0]?.id ?? null;
    room.members.forEach((m) => {
      m.isLeader = m.id === room.leaderId;
    });
  }

  if (room.members.length === 0) {
    room.isPlaying = false;
    room.startServerTime = null;
    roomEmptySince.set(roomId, Date.now());
  } else {
    broadcastToRoom(roomId, { type: 'members_update', members: room.members });
  }
}

function takeToken(ctx: ClientContext): boolean {
  const now = Date.now();
  ctx.tokens = Math.min(RATE_BUCKET_SIZE, ctx.tokens + ((now - ctx.lastRefill) / 1000) * RATE_REFILL_PER_SEC);
  ctx.lastRefill = now;
  if (ctx.tokens < 1) return false;
  ctx.tokens -= 1;
  return true;
}

wss.on('connection', (ws) => {
  // Disable Nagle's algorithm so small sync messages are not buffered
  try {
    const rawSocket = (ws as unknown as { _socket?: { setNoDelay?: (noDelay: boolean) => void } })._socket;
    rawSocket?.setNoDelay?.(true);
  } catch {}

  const ctx: ClientContext = {
    authenticated: false,
    id: 'musician-' + Math.random().toString(36).substring(2, 12),
    ws,
    roomId: null,
    name: 'Músico',
    instrument: 'other',
    color: getRandomColor(),
    isAlive: true,
    replaced: false,
    tokens: RATE_BUCKET_SIZE,
    lastRefill: Date.now(),
    warnedRateLimit: false,
  };
  clients.set(ws, ctx);

  ws.on('pong', () => {
    ctx.isAlive = true;
  });

  ws.on('error', () => {});

  ws.on('message', (data) => {
    ctx.isAlive = true;
    if (!takeToken(ctx)) {
      if (!ctx.warnedRateLimit) {
        ctx.warnedRateLimit = true;
        send(ws, { type: 'error', code: 'rate_limited', message: 'Demasiados mensajes seguidos. Esperá un momento.' });
      }
      return;
    }
    ctx.warnedRateLimit = false;

    let msg: WSClientMessage;
    try {
      msg = JSON.parse(data.toString()) as WSClientMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    try {
      handleMessage(ctx, msg);
    } catch (err) {
      console.error('Error handling WebSocket message:', err);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // A replaced socket already handed its seat to the newer connection of the same device
    if (!ctx.replaced) removeFromRoom(ctx);
  });
});

function handleMessage(ctx: ClientContext, msg: WSClientMessage) {
  const ws = ctx.ws;

  if (msg.type === 'ping') {
    // Instant response for NTP-style latency & clock offset estimation
    send(ws, { type: 'pong', clientTime: Number(msg.clientTime) || 0, serverTime: Date.now() });
    return;
  }

  if (msg.type === 'join') {
    handleJoin(ctx, msg);
    return;
  }

  if (!ctx.roomId) return;
  const room = rooms.get(ctx.roomId);
  if (!room) return;

  const isDrummer = ctx.instrument === 'drums';
  const denyUnlessDrummer = (message: string) => {
    if (isDrummer) return false;
    send(ws, { type: 'error', message });
    return true;
  };

  switch (msg.type) {
    case 'report_ping': {
      const pingMs = clampInt(msg.pingMs, 0, 10_000);
      const member = room.members.find((m) => m.id === ctx.id);
      if (member && pingMs !== null && member.pingMs !== pingMs) {
        member.pingMs = pingMs;
        broadcastToRoom(room.roomId, { type: 'members_update', members: room.members });
      }
      break;
    }

    case 'play': {
      if (denyUnlessDrummer('Sólo el baterista puede iniciar el metrónomo.')) return;
      room.isPlaying = true;
      room.startServerTime = Date.now() + PLAY_LEAD_MS;
      room.countInBeats = room.countInBars * room.timeSignature.numerator;
      broadcastPlayback(room);
      break;
    }

    case 'stop': {
      if (denyUnlessDrummer('Sólo el baterista puede detener el metrónomo.')) return;
      room.isPlaying = false;
      room.startServerTime = null;
      room.countInBeats = 0;
      broadcastPlayback(room);
      break;
    }

    case 'setBpm': {
      if (denyUnlessDrummer('Sólo el baterista puede modificar el tempo.')) return;
      const bpm = clampInt(msg.bpm, MIN_BPM, MAX_BPM);
      if (bpm === null || bpm === room.bpm) return;
      rebaseToNextBar(room);
      room.bpm = bpm;
      broadcastPlayback(room);
      break;
    }

    case 'setTimeSignature': {
      if (denyUnlessDrummer('Sólo el baterista puede cambiar el compás.')) return;
      const ts = sanitizeTimeSignature(msg.timeSignature);
      if (!ts) return;
      rebaseToNextBar(room);
      room.timeSignature = ts;
      room.accentPattern = sanitizeAccentPattern(msg.accentPattern, ts.numerator);
      broadcastPlayback(room);
      break;
    }

    case 'setSubdivision': {
      if (denyUnlessDrummer('Sólo el baterista puede cambiar la subdivisión.')) return;
      const sub = sanitizeSubdivision(msg.subdivision);
      if (!sub) return;
      // Beat grid is unchanged, so this applies immediately without re-anchoring
      room.subdivision = sub;
      broadcastPlayback(room);
      break;
    }

    case 'setAccentPattern': {
      if (denyUnlessDrummer('Sólo el baterista puede cambiar los acentos.')) return;
      room.accentPattern = sanitizeAccentPattern(msg.accentPattern, room.timeSignature.numerator);
      broadcastPlayback(room);
      break;
    }

    case 'setCountInBars': {
      if (denyUnlessDrummer('Sólo el baterista puede cambiar la cuenta previa.')) return;
      const bars = clampInt(msg.countInBars, 0, 2);
      if (bars === null) return;
      room.countInBars = bars;
      broadcastRoomState(room);
      break;
    }

    case 'sendCue': {
      const text = cleanText(msg.text, 120);
      if (!text) return;
      const cue: RehearsalCue = {
        id: 'cue-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
        senderName: ctx.name,
        text,
        timestamp: Date.now(),
        type: CUE_TYPES.includes(msg.cueType) ? msg.cueType : 'custom',
      };
      room.recentCues.unshift(cue);
      room.recentCues.length = Math.min(room.recentCues.length, 20);
      broadcastToRoom(room.roomId, { type: 'cue_broadcast', cue });
      break;
    }

    case 'updateSetlist': {
      if (denyUnlessDrummer('Sólo el baterista puede actualizar el setlist de la sala.')) return;
      const setlist = sanitizeSetlist(msg.setlist);
      if (!setlist) return;
      const hasMeta = 'setlistId' in msg || 'setlistName' in msg;
      applySetlist(room, setlist, hasMeta ? sanitizeSetlistMeta(msg.setlistId, msg.setlistName) : undefined);
      broadcastRoomState(room);
      break;
    }

    case 'selectSong': {
      if (denyUnlessDrummer('Sólo el baterista puede cambiar de tema.')) return;
      const song = room.setlist.find((s) => s.id === msg.songId);
      if (!song) return;
      rebaseToNextBar(room);
      room.currentSongId = song.id;
      room.bpm = song.bpm;
      room.timeSignature = song.timeSignature;
      room.subdivision = song.subdivision;
      room.accentPattern = song.accentPattern;
      broadcastToRoom(room.roomId, { type: 'song_selected', song });
      broadcastPlayback(room);
      break;
    }

    case 'updateMember': {
      const name = cleanText(msg.name, 25);
      const instrument = sanitizeInstrument(msg.instrument);

      if (
        instrument === 'drums' &&
        ctx.instrument !== 'drums' &&
        room.members.some((m) => m.instrument === 'drums' && m.id !== ctx.id)
      ) {
        send(ws, { type: 'error', code: 'drums_taken', message: 'El rol de batería ya está ocupado en esta sala.' });
        return;
      }

      if (name) ctx.name = name;
      if (instrument) ctx.instrument = instrument;

      const member = room.members.find((m) => m.id === ctx.id);
      if (member) {
        member.name = ctx.name;
        member.instrument = ctx.instrument;
      }
      broadcastToRoom(room.roomId, { type: 'members_update', members: room.members });
      break;
    }
  }
}

function handleJoin(ctx: ClientContext, msg: Extract<WSClientMessage, { type: 'join' }>) {
  const ws = ctx.ws;
  const roomId = sanitizeRoomId(msg.roomId);
  if (!roomId) {
    send(ws, { type: 'error', message: 'Código de sala inválido.' });
    return;
  }

  const clientId = sanitizeClientId(msg.clientId);
  const instrument = sanitizeInstrument(msg.instrument) ?? 'other';
  const name = cleanText(msg.name, 25) || 'Músico';

  if (!clientId || (ctx.authenticated && ctx.id !== clientId)) {
    send(ws, { type: 'error', code: 'identity_conflict', message: 'La identidad de esta conexión no es válida. Volvé a entrar.' });
    return;
  }
  const session = deviceSessions.get(clientId);
  if (session && !validDeviceToken(msg.deviceToken, session.token)) {
    send(ws, { type: 'error', code: 'identity_conflict', message: 'No se pudo recuperar este dispositivo. La conexión original sigue activa.' });
    return;
  }
  const targetRoom = rooms.get(roomId);
  const alreadyMember = targetRoom?.members.some((m) => m.id === clientId);
  const access = roomAccess(roomId);
  if (!alreadyMember && access.memberLimit !== null && (targetRoom?.members.length ?? 0) >= access.memberLimit) {
    send(ws, { type: 'error', code: 'room_full', message: 'Esta sala llegó al límite gratuito de 2 integrantes. Desde el tercero necesitás SyncroBeat Pro.' });
    return;
  }
  if (instrument === 'drums' && targetRoom?.members.some((m) => m.instrument === 'drums' && m.id !== clientId)) {
    send(ws, { type: 'error', code: 'drums_taken', message: 'Ya hay un baterista en esta sala.' });
    return;
  }

  // Leaving a previous room on the same socket
  if (ctx.roomId && ctx.roomId !== roomId) removeFromRoom(ctx);

  if (clientId && clientId !== ctx.id) {
    // Same device reconnecting (e.g. phone woke up): retire the stale socket and keep the seat
    for (const [otherWs, other] of clients.entries()) {
      if (other !== ctx && other.id === clientId) {
        other.replaced = other.roomId === roomId;
        if (!other.replaced) removeFromRoom(other);
        clients.delete(otherWs);
        otherWs.terminate();
      }
    }
    ctx.id = clientId;
  }

  ctx.authenticated = true;
  const deviceToken = session?.token ?? randomBytes(32).toString('base64url');
  deviceSessions.set(clientId, { token: deviceToken, lastSeen: Date.now() });

  const room = getOrCreateRoom(roomId);

  if (instrument === 'drums' && room.members.some((m) => m.instrument === 'drums' && m.id !== ctx.id)) {
    send(ws, { type: 'error', code: 'drums_taken', message: 'Ya hay un baterista en esta sala.' });
    if (room.members.length === 0) roomEmptySince.set(roomId, Date.now());
    return;
  }

  ctx.roomId = roomId;
  ctx.name = name;
  ctx.instrument = instrument;

  // A drummer may bring a prepared list into an empty, stopped room.
  // Existing room lists and active playback always take precedence.
  let setlistLoaded = false;
  if (instrument === 'drums' && room.setlist.length === 0 && !room.isPlaying && msg.initialSetlist) {
    // Older app versions send a plain array of songs instead of a named setlist
    const initial = msg.initialSetlist as unknown;
    const named = Array.isArray(initial) ? { id: null, name: null, songs: initial } : (initial as Record<string, unknown>);
    const prepared = sanitizeSetlist(named.songs);
    if (prepared?.length) {
      room.currentSongId = null;
      applySetlist(room, prepared, sanitizeSetlistMeta(named.id, named.name));
      setlistLoaded = true;
    }
  }

  if (!room.leaderId || !room.members.some((m) => m.id === room.leaderId)) {
    room.leaderId = ctx.id;
  }

  const existing = room.members.find((m) => m.id === ctx.id);
  const memberInfo: MemberInfo = {
    id: ctx.id,
    name: ctx.name,
    instrument: ctx.instrument,
    isLeader: room.leaderId === ctx.id,
    pingMs: existing?.pingMs ?? 0,
    color: existing?.color ?? ctx.color,
    joinedAt: existing?.joinedAt ?? Date.now(),
  };
  ctx.color = memberInfo.color;

  if (existing) {
    room.members[room.members.indexOf(existing)] = memberInfo;
  } else {
    room.members.push(memberInfo);
  }

  send(ws, { type: 'device_session', deviceToken });
  send(ws, { type: 'room_state', state: room, yourId: ctx.id });
  // Everyone else only needs the full state when the setlist changed; otherwise the member list
  if (setlistLoaded) broadcastRoomState(room, ws);
  else broadcastToRoom(roomId, { type: 'members_update', members: room.members }, ws);
}

// Drop sockets that stopped answering (phone asleep, network gone) so their seat frees up
const heartbeat = setInterval(() => {
  for (const [ws, ctx] of clients.entries()) {
    if (!ctx.isAlive) {
      ws.terminate();
      continue;
    }
    ctx.isAlive = false;
    try {
      ws.ping();
    } catch {}
  }
}, HEARTBEAT_INTERVAL_MS);

// Forget rooms that have been empty for a while
const roomSweeper = setInterval(() => {
  const now = Date.now();
  const activeIds = new Set([...clients.values()].map((ctx) => ctx.id));
  for (const [id, session] of deviceSessions) {
    if (!activeIds.has(id) && now - session.lastSeen > EMPTY_ROOM_TTL_MS) deviceSessions.delete(id);
  }
  for (const [roomId, since] of roomEmptySince.entries()) {
    const room = rooms.get(roomId);
    if (!room || (room.members.length === 0 && now - since > EMPTY_ROOM_TTL_MS)) {
      rooms.delete(roomId);
      roomEmptySince.delete(roomId);
    }
  }
}, 60_000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(roomSweeper);
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

// Ensure Service Worker, manifest, and HTML are never cached by browsers
app.get(['/sw.js', '/manifest.webmanifest', '/*.html'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  next();
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    serverTime: Date.now(),
    activeRooms: rooms.size,
    connectedMusicians: clients.size,
  });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(sanitizeRoomId(req.params.id));
  if (!room) {
    // A room that does not exist yet is created on the first join
    return res.json({ exists: false, membersCount: 0, drumsTaken: false, ...roomAccess(sanitizeRoomId(req.params.id)) });
  }
  res.json({
    exists: true,
    ...roomAccess(room.roomId),
    roomId: room.roomId,
    roomName: room.roomName,
    bpm: room.bpm,
    membersCount: room.members.length,
    isPlaying: room.isPlaying,
    setlistCount: room.setlist.length,
    // The asking device's own seat does not count, so a drummer can rejoin their room
    drumsTaken: room.members.some((m) => m.instrument === 'drums' && m.id !== req.query.clientId),
  });
});

async function startServer() {
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(
      express.static('dist', {
        setHeaders: (res, filePath) => {
          if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          }
        },
      })
    );
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other server or set PORT.` : 'Server error:',
      err.code === 'EADDRINUSE' ? '' : err
    );
    process.exit(1);
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`SyncroBeat server listening on http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
