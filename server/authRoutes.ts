/**
 * The three endpoints behind "entrar con Google": sign in, who am I, sign out.
 *
 * Every dependency is passed in rather than imported, so these can be exercised against fakes in a
 * test without a database, without Google and without a production-only switch in the code -- the
 * kind of switch that eventually gets left on.
 */
import express, { type Express, type Request, type Response } from 'express';
import type { GoogleIdentity } from './googleToken.ts';
import type { Account } from './accounts.ts';
import type { Entitlement } from './entitlements.ts';

export const SESSION_COOKIE = 'sb_session';

export interface AuthDeps {
  /** Verifies a Google credential, or throws. */
  verifyToken: (credential: string) => Promise<GoogleIdentity>;
  accounts: {
    signIn: (identity: GoogleIdentity) => Promise<{ account: Account; token: string; expiresAt: Date; isNew: boolean }>;
    fromToken: (token: string | undefined) => Promise<Account | null>;
    signOut: (token: string | undefined) => Promise<void>;
  };
  entitlementOf: (accountId: string) => Promise<Entitlement>;
  /** Secure cookies need HTTPS, which local development does not have. */
  isProduction: boolean;
}

/** Reads one cookie without pulling in a parser dependency for a single value. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function sessionToken(req: Request): string | undefined {
  return readCookie(req.headers.cookie, SESSION_COOKIE);
}

export function mountAuth(app: Express, deps: AuthDeps): void {
  // Scoped to these routes so the rest of the server keeps receiving raw bodies as it always has
  const json = express.json({ limit: '8kb' });

  app.post('/api/auth/google', json, async (req: Request, res: Response) => {
    const credential = (req.body as { credential?: unknown })?.credential;
    if (typeof credential !== 'string' || !credential) {
      return res.status(400).json({ error: 'Falta el dato de Google.' });
    }

    let identity: GoogleIdentity;
    try {
      identity = await deps.verifyToken(credential);
    } catch (err) {
      // The real reason goes to the log, never to the caller: telling an attacker which check
      // failed is free help. The musician only needs to know it did not work.
      console.warn('Rejected Google credential:', (err as Error).message);
      return res.status(401).json({ error: 'No pudimos verificar tu cuenta de Google.' });
    }

    try {
      const { account, token, expiresAt, isNew } = await deps.accounts.signIn(identity);
      res.cookie(SESSION_COOKIE, token, {
        httpOnly: true, // JavaScript on the page can never read it, so a script injection cannot steal it
        secure: deps.isProduction,
        sameSite: 'lax',
        path: '/',
        expires: expiresAt,
      });
      const entitlement = await deps.entitlementOf(account.id);
      res.json({ account, plan: entitlement.plan, until: entitlement.until, isNew });
    } catch (err) {
      console.error('Sign-in failed:', (err as Error).message);
      res.status(503).json({ error: 'No pudimos abrir tu sesión. Probá de nuevo en un momento.' });
    }
  });

  app.get('/api/auth/me', async (req: Request, res: Response) => {
    try {
      const account = await deps.accounts.fromToken(sessionToken(req));
      if (!account) return res.json({ account: null, plan: 'free' });
      const entitlement = await deps.entitlementOf(account.id);
      res.json({ account, plan: entitlement.plan, until: entitlement.until, source: entitlement.source });
    } catch (err) {
      // Not knowing who you are is not an error the page should act on; it just means no account
      console.error('Session lookup failed:', (err as Error).message);
      res.json({ account: null, plan: 'free', degraded: true });
    }
  });

  app.post('/api/auth/logout', async (req: Request, res: Response) => {
    try {
      await deps.accounts.signOut(sessionToken(req));
    } catch (err) {
      console.error('Sign-out failed:', (err as Error).message);
    }
    // The cookie goes regardless: a musician who asked to sign out must end up signed out here,
    // even if the row could not be deleted right now.
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
}
