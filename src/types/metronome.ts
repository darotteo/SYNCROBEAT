export type InstrumentType =
  | 'drums'
  | 'guitar'
  | 'bass'
  | 'keys'
  | 'vocals'
  | 'horns'
  | 'strings'
  | 'other';

export const INSTRUMENT_TYPES: InstrumentType[] = ['drums', 'guitar', 'bass', 'keys', 'vocals', 'horns', 'strings', 'other'];

export type SoundPreset = 'woodblock' | 'digital' | 'cowbell' | 'drumstick' | 'synth';

export type Subdivision = '1' | '2' | '3' | '4'; // 1: Quarter, 2: Eighths, 3: Triplets, 4: Sixteenths

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface SongItem {
  id: string;
  title: string;
  bpm: number;
  timeSignature: TimeSignature;
  subdivision: Subdivision;
  accentPattern: number[]; // 2 = accent, 1 = normal, 0 = silent
  notes?: string;
}

export interface MemberInfo {
  id: string;
  name: string;
  instrument: InstrumentType;
  isLeader: boolean;
  pingMs: number;
  color: string;
  joinedAt: number;
}

export interface RehearsalCue {
  id: string;
  senderName: string;
  text: string;
  timestamp: number;
  type: 'count-in' | 'section' | 'stop' | 'speed' | 'custom';
}

export const CUE_TYPES: RehearsalCue['type'][] = ['count-in', 'section', 'stop', 'speed', 'custom'];

/** Timing of the running metronome: everything a client needs to compute beat phase. */
export interface PlaybackState {
  isPlaying: boolean;
  startServerTime: number | null; // Server timestamp (epoch ms) of beat 0 (first count-in beat if any)
  countInBeats: number; // Beats at the start of this segment that are count-in clicks
  bpm: number;
  timeSignature: TimeSignature;
  subdivision: Subdivision;
  accentPattern: number[];
}

export interface RoomState extends PlaybackState {
  roomId: string;
  roomName: string;
  countInBars: number; // 0 = none, 1 = 1 bar, 2 = 2 bars
  leaderId: string | null;
  currentSongId: string | null;
  setlist: SongItem[];
  /** Saved setlist the room list came from (id in the drummer's library) and its name. */
  setlistId: string | null;
  setlistName: string | null;
  members: MemberInfo[];
  recentCues: RehearsalCue[];
}

/** A setlist with a name, saved on the device and loadable into a room. */
export interface NamedSetlist {
  id: string;
  name: string;
  songs: SongItem[];
}

export type WSClientMessage =
  | { type: 'join'; roomId: string; name: string; instrument: InstrumentType; clientId: string; initialSetlist?: NamedSetlist }
  | { type: 'leave' }
  | { type: 'ping'; clientTime: number }
  | { type: 'report_ping'; pingMs: number }
  | { type: 'play' }
  | { type: 'stop' }
  | { type: 'setBpm'; bpm: number }
  | { type: 'setTimeSignature'; timeSignature: TimeSignature; accentPattern?: number[] }
  | { type: 'setSubdivision'; subdivision: Subdivision }
  | { type: 'setAccentPattern'; accentPattern: number[] }
  | { type: 'setCountInBars'; countInBars: number }
  | { type: 'sendCue'; text: string; cueType: RehearsalCue['type'] }
  // Without setlistId/setlistName the room keeps its current name (plain edits)
  | { type: 'updateSetlist'; setlist: SongItem[]; setlistId?: string | null; setlistName?: string | null }
  | { type: 'selectSong'; songId: string }
  | { type: 'updateMember'; name?: string; instrument?: InstrumentType }
  | { type: 'setHost'; memberId: string };

export type WSServerMessage =
  | { type: 'pong'; clientTime: number; serverTime: number }
  | { type: 'room_state'; state: RoomState; yourId: string }
  | ({ type: 'playback_state' } & PlaybackState)
  | { type: 'members_update'; members: MemberInfo[] }
  | { type: 'cue_broadcast'; cue: RehearsalCue }
  | { type: 'song_selected'; song: SongItem }
  | { type: 'error'; message: string; code?: 'drums_taken' | 'rate_limited' };

export const MIN_BPM = 30;
export const MAX_BPM = 300;
export const MAX_SETLIST_SONGS = 150;

export const COMMON_SIGNATURES: TimeSignature[] = [
  { numerator: 4, denominator: 4 },
  { numerator: 3, denominator: 4 },
  { numerator: 2, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 5, denominator: 4 },
  { numerator: 7, denominator: 8 },
  { numerator: 12, denominator: 8 },
];

export function defaultAccentPattern(numerator: number): number[] {
  return Array.from({ length: numerator }, (_, i) => (i === 0 ? 2 : 1));
}
