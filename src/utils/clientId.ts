const CLIENT_ID_KEY = 'syncbeat_client_id';

let memoryId: string | null = null;

/** Stable per-device id so a reconnect (phone waking up) reclaims the same seat in the room. */
export function getClientId(): string {
  try {
    const saved = localStorage.getItem(CLIENT_ID_KEY);
    if (saved && /^[A-Za-z0-9-]{8,64}$/.test(saved)) return saved;
  } catch {}

  if (!memoryId) {
    memoryId =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  try {
    localStorage.setItem(CLIENT_ID_KEY, memoryId);
  } catch {}
  return memoryId;
}
