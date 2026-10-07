import { SongItem, MIN_BPM, MAX_BPM, COMMON_SIGNATURES, defaultAccentPattern } from '../types/metronome';

export function newSongId() {
  return 'song-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
}

export function clampBpm(value: number) {
  return Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(value) || 120));
}

/**
 * Parses a setlist pasted from WhatsApp, Notes or plain text. One song per line:
 * "1. Despido Inicial - 95", "Virus Intro Piano, 95 bpm", "Rock 120", "Balada (80)"
 */
export function parsePastedList(text: string, defaultBpm: number): SongItem[] {
  const items: SongItem[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const raw of lines) {
    // Remove leading numbering like "1.", "01 -", "1)", "[1]", "Tema 3:"; a song actually called
    // "Tema 5" keeps its name (nothing but a number would remain otherwise)
    const unstarred = raw.replace(/[*_]/g, '').trim();
    const unnumbered = unstarred.replace(/^(\[?\d+\s*[.):\-\]]\s*|tema\s*\d+\s*[.):\-]\s*)/i, '').trim();
    let clean = /\p{L}/u.test(unnumbered) ? unnumbered : unstarred;
    let bpm = defaultBpm;
    let notes: string | undefined;

    const explicitBpm = clean.match(/(?:bpm|tempo)[:\s]*(\d{2,3})\b|\b(\d{2,3})\s*bpm\b/i);
    if (explicitBpm) {
      const parsed = parseInt(explicitBpm[1] || explicitBpm[2], 10);
      if (parsed >= MIN_BPM && parsed <= MAX_BPM) bpm = parsed;
      clean = clean.replace(explicitBpm[0], '').trim();
    } else {
      const trailing = clean.match(/[-,(\s]+(\d{2,3})\s*\)?$/);
      if (trailing) {
        const parsed = parseInt(trailing[1], 10);
        if (parsed >= MIN_BPM && parsed <= MAX_BPM) {
          bpm = parsed;
          clean = clean.slice(0, trailing.index).trim();
        }
      }
    }

    clean = clean.replace(/[-–,;:]+$/, '').trim();

    const notesMatch = clean.match(/\((.*?)\)/);
    if (notesMatch) {
      notes = notesMatch[1].trim() || undefined;
      clean = clean.replace(/\(.*?\)/, '').trim();
    }

    if (clean) {
      items.push({
        id: newSongId() + items.length,
        title: clean.slice(0, 80),
        bpm,
        timeSignature: { numerator: 4, denominator: 4 },
        subdivision: '1',
        accentPattern: defaultAccentPattern(4),
        ...(notes ? { notes } : {}),
      });
    }
  }
  return items;
}

/** Reads a setlist exported by SyncroBeat or Batuta (or any JSON array of songs with title and bpm). */
export function parseSetlistJson(text: string): { name?: string; songs: SongItem[] } {
  const data = JSON.parse(text);
  const rawSongs: unknown[] = Array.isArray(data) ? data : Array.isArray(data?.songs) ? data.songs : [];
  const songs: SongItem[] = [];
  for (const raw of rawSongs) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, any>;
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, 80) : '';
    if (!title) continue;
    const sig = COMMON_SIGNATURES.find(
      (s) => s.numerator === r.timeSignature?.numerator && s.denominator === r.timeSignature?.denominator
    ) ?? { numerator: 4, denominator: 4 };
    const pattern =
      Array.isArray(r.accentPattern) && r.accentPattern.length === sig.numerator
        ? r.accentPattern.map((v: unknown) => Math.max(0, Math.min(2, Math.round(Number(v)) || 0)))
        : defaultAccentPattern(sig.numerator);
    const notes = typeof r.notes === 'string' ? r.notes.trim().slice(0, 160) : '';
    songs.push({
      id: newSongId() + songs.length,
      title,
      bpm: clampBpm(Number(r.bpm)),
      timeSignature: sig,
      subdivision: ['1', '2', '3', '4'].includes(r.subdivision) ? r.subdivision : '1',
      accentPattern: pattern,
      ...(notes ? { notes } : {}),
    });
  }
  return { name: typeof data?.name === 'string' ? data.name.slice(0, 80) : undefined, songs };
}
