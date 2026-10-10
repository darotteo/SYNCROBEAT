import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { resolveServerUrls } from './serverUrls';

export const isNativeApp = () => Capacitor.isNativePlatform();

let screenRequest = Promise.resolve();
export function setNativeScreenAwake(enabled: boolean) {
  // Keep transitions in order when a room closes while a native call is pending.
  screenRequest = screenRequest.then(() => enabled ? KeepAwake.keepAwake() : KeepAwake.allowSleep()).catch(error => console.warn('No se pudo cambiar la pantalla encendida', error));
}

export function connectionUrls() {
  return resolveServerUrls(import.meta.env.VITE_SYNCROBEAT_API_URL, import.meta.env.VITE_SYNCROBEAT_SHARE_URL,
    window.location.origin, isNativeApp());
}

export function apiUrl(path: string) { return new URL(path, connectionUrls().api).href; }

/** Only accept invite links belonging to the configured public server. */
function openInvite(url: string) {
  try {
    const invite = new URL(url);
    if (invite.origin !== connectionUrls().share) return;
    const room = invite.searchParams.get('room');
    if (room && /^[A-Za-z0-9-]{1,20}$/.test(room)) {
      window.location.assign(`/?room=${encodeURIComponent(room.toUpperCase())}`);
    }
  } catch {}
}

export async function initializeNativeApp() {
  if (!isNativeApp()) return;
  await App.addListener('appUrlOpen', ({ url }) => openInvite(url));
  const initial = await App.getLaunchUrl();
  if (initial?.url) openInvite(initial.url);
  await App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) window.dispatchEvent(new Event('pageshow'));
  });
  // Ordinary Android Back closes the foremost modal before leaving the app.
  await App.addListener('backButton', () => {
    if (document.querySelector('[role="dialog"]')) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    } else if (window.history.length > 1) window.history.back();
    else void App.minimizeApp();
  });
}
