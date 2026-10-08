/**
 * Where the room server lives.
 *
 * On the web the app is served by that same server, so the page's own origin is the right answer.
 * Packaged as a native app the page is loaded from inside the device (capacitor://localhost), where
 * the origin points at the phone itself — so the real address has to be fixed at build time with
 * VITE_SERVER_URL. Getting this wrong fails silently: the metronome looks fine and no room ever
 * connects.
 *
 * Bundled assets (sounds, fonts, icons) are a different matter: they ship with the app and must
 * keep being requested from the page's own origin, so they do not go through here.
 */
const configured = (import.meta.env.VITE_SERVER_URL || '').trim().replace(/\/+$/, '');

/** Origin of the room server, e.g. "https://syncrobeat.onrender.com". */
export function serverOrigin(): string {
  return configured || window.location.origin;
}

/** Absolute URL for a server endpoint; `path` starts with a slash. */
export function apiUrl(path: string): string {
  return serverOrigin() + path;
}

/** WebSocket address of the room server, with the scheme that matches its origin. */
export function roomSocketUrl(): string {
  const url = new URL('/api/ws', serverOrigin());
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/**
 * Address to invite other musicians to. It is the server's, never the page's: a native app that
 * shared its own origin would hand out a link to the inviter's phone.
 */
export function invitationUrl(roomId: string): string {
  return `${serverOrigin()}/?room=${encodeURIComponent(roomId)}`;
}
