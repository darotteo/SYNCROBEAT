import { useCallback, useEffect, useRef, useState } from 'react';
import { apiUrl } from '../utils/mobile';

/**
 * Who is signed in and what they are entitled to.
 *
 * Signing in is only ever needed to pay. Solo practice, the free duo and joining a room with a code
 * work with no account at all, so everything here fails quietly: if the server has no accounts
 * configured, or the database is down, the app keeps working and simply shows the free plan.
 */

export interface AccountInfo {
  id: string;
  email: string;
  name: string | null;
}

export interface AccountState {
  account: AccountInfo | null;
  plan: 'free' | 'pro';
  until: Date | null;
  /** True while the first check is in flight, so the UI does not flash "free" at a paying musician. */
  loading: boolean;
  /** The server could not reach its database; what we show may be out of date. */
  degraded: boolean;
}

const GOOGLE_SCRIPT = 'https://accounts.google.com/gsi/client';
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

interface GoogleAccounts {
  id: {
    initialize: (config: { client_id: string; callback: (r: { credential: string }) => void }) => void;
    renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
    prompt: () => void;
    disableAutoSelect: () => void;
  };
}

let scriptPromise: Promise<void> | null = null;

/** Loads Google's sign-in script once, on demand: it is not downloaded unless somebody signs in. */
function loadGoogleScript(): Promise<void> {
  if (typeof document === 'undefined') return Promise.reject(new Error('no document'));
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_SCRIPT}"]`);
    if (existing) return resolve();
    const script = document.createElement('script');
    script.src = GOOGLE_SCRIPT;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null; // let a later attempt retry rather than fail forever
      reject(new Error('No se pudo cargar el inicio de sesión de Google.'));
    };
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function useAccount() {
  const [state, setState] = useState<AccountState>({ account: null, plan: 'free', until: null, loading: true, degraded: false });
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const apply = useCallback((data: Record<string, unknown>) => {
    if (!mounted.current) return;
    setState({
      account: (data.account as AccountInfo | null) ?? null,
      plan: data.plan === 'pro' ? 'pro' : 'free',
      until: data.until ? new Date(String(data.until)) : null,
      loading: false,
      degraded: Boolean(data.degraded),
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/me'), { credentials: 'include' });
      if (!res.ok) throw new Error(String(res.status));
      apply(await res.json());
    } catch {
      // No accounts configured, or offline. Neither is an error worth showing: the app works.
      if (mounted.current) setState((s) => ({ ...s, loading: false }));
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Exchanges the credential Google handed us for a session on our own server. */
  const completeSignIn = useCallback(
    async (credential: string) => {
      setError(null);
      try {
        const res = await fetch(apiUrl('/api/auth/google'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ credential }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || 'No pudimos iniciar sesión.');
        apply(data);
        return true;
      } catch (err) {
        if (mounted.current) setError((err as Error).message);
        return false;
      }
    },
    [apply]
  );

  const signOut = useCallback(async () => {
    try {
      await fetch(apiUrl('/api/auth/logout'), { method: 'POST', credentials: 'include' });
      // Otherwise Google signs the same person straight back in on the next visit
      (window as unknown as { google?: GoogleAccounts }).google?.id.disableAutoSelect();
    } catch {
      // Ignored on purpose: the session is cleared server-side and the state below reflects it
    }
    if (mounted.current) setState({ account: null, plan: 'free', until: null, loading: false, degraded: false });
  }, []);

  /** Draws Google's own button into `target`. Theirs, because a fake one is a known phishing shape. */
  const renderButton = useCallback(
    async (target: HTMLElement) => {
      if (!CLIENT_ID) {
        setError('El inicio de sesión no está configurado en este servidor.');
        return;
      }
      try {
        await loadGoogleScript();
        const google = (window as unknown as { google?: GoogleAccounts }).google;
        if (!google) throw new Error('No se pudo cargar el inicio de sesión de Google.');
        google.id.initialize({
          client_id: CLIENT_ID,
          callback: (response) => void completeSignIn(response.credential),
        });
        google.id.renderButton(target, { type: 'standard', theme: 'filled_black', size: 'large', text: 'continue_with', locale: 'es' });
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [completeSignIn]
  );

  return { ...state, error, refresh, renderButton, signOut, isConfigured: Boolean(CLIENT_ID) };
}
