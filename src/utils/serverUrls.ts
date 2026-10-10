export interface ServerUrls { api: string; websocket: string; share: string }

export function resolveServerUrls(apiOrigin: string | undefined, shareOrigin: string | undefined, localOrigin: string, native = false): ServerUrls {
  const base = apiOrigin?.trim() || (native ? '' : localOrigin);
  if (!base) throw new Error('Falta configurar la dirección del servidor para esta versión móvil.');
  const parsed = new URL(base);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal && !native)) {
    throw new Error('La conexión a la sala necesita una dirección HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('La dirección del servidor debe ser el origen, sin sala, ruta ni credenciales.');
  }
  const ws = new URL('/api/ws', parsed);
  ws.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  const share = new URL(shareOrigin?.trim() || parsed.origin);
  const shareIsLocal = ['localhost', '127.0.0.1', '[::1]'].includes(share.hostname);
  if (share.protocol !== 'https:' && !(share.protocol === 'http:' && shareIsLocal && !native)) throw new Error('El enlace para compartir necesita HTTPS.');
  if (share.username || share.password || share.search || share.hash || share.pathname !== '/') throw new Error('La dirección para compartir debe ser el origen, sin sala, ruta ni credenciales.');
  return { api: parsed.origin, websocket: ws.href, share: share.origin };
}
