import { NamedSetlist } from '../types/metronome';

const KEY = 'syncbeat_setlist_library';
const LEGACY_KEY = 'syncbeat_custom_local_setlist'; // Old single "Mi lista"
const LEGACY_MIGRATED_KEY = 'syncbeat_legacy_list_migrated';
const LAST_SELECTED_KEY = 'syncbeat_last_setlist_id';

function isValid(list: any): list is NamedSetlist {
  return typeof list?.id === 'string' && typeof list?.name === 'string' && Array.isArray(list?.songs);
}

/**
 * All setlists saved on this device. The old single "Mi lista" is folded in once as a named
 * setlist, so there is only one place where lists live.
 */
export function loadSetlistLibrary(): NamedSetlist[] {
  let lists: NamedSetlist[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    lists = Array.isArray(saved) ? saved.filter(isValid) : [];
  } catch {}

  try {
    if (!localStorage.getItem(LEGACY_MIGRATED_KEY)) {
      const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]');
      if (Array.isArray(legacy) && legacy.length && !lists.some((l) => l.id === 'my-list')) {
        lists = [...lists, { id: 'my-list', name: 'Mi setlist', songs: legacy }];
        localStorage.setItem(KEY, JSON.stringify(lists));
      }
      localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
    }
  } catch {}

  return lists;
}

export function saveSetlistLibrary(lists: NamedSetlist[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(lists));
    return true;
  } catch {
    return false;
  }
}

/** Creates or replaces one setlist (matched by id). Returns the new library, or null if it could not be saved. */
export function upsertSetlist(list: NamedSetlist): NamedSetlist[] | null {
  const current = loadSetlistLibrary();
  const next = current.some((l) => l.id === list.id) ? current.map((l) => (l.id === list.id ? list : l)) : [...current, list];
  return saveSetlistLibrary(next) ? next : null;
}

/** Keeps a saved setlist up to date with edits made to the room list, if this device has it. */
export function syncSavedSetlist(id: string | null | undefined, name: string | null | undefined, songs: NamedSetlist['songs']) {
  if (!id || songs.length === 0) return;
  const existing = loadSetlistLibrary().find((l) => l.id === id);
  if (existing) upsertSetlist({ id, name: name || existing.name, songs });
}

export function deleteSetlist(id: string): NamedSetlist[] | null {
  const next = loadSetlistLibrary().filter((l) => l.id !== id);
  return saveSetlistLibrary(next) ? next : null;
}

export function getSetlist(id: string | null | undefined): NamedSetlist | undefined {
  return id ? loadSetlistLibrary().find((l) => l.id === id) : undefined;
}

let setlistSequence = 0;
export function newSetlistId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `setlist-${crypto.randomUUID()}`;
  return `setlist-${Date.now().toString(36)}-${(setlistSequence++).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function loadLastSelectedSetlistId(): string {
  try {
    return localStorage.getItem(LAST_SELECTED_KEY) || '';
  } catch {
    return '';
  }
}

export function saveLastSelectedSetlistId(id: string) {
  try {
    if (id) localStorage.setItem(LAST_SELECTED_KEY, id);
    else localStorage.removeItem(LAST_SELECTED_KEY);
  } catch {}
}
