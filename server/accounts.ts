/**
 * Accounts and sessions for the paid plan.
 *
 * A session token is a long random string that only ever lives in the musician's cookie. What we
 * store is its SHA-256 hash, so a copy of the sessions table is useless to whoever steals it: a
 * hash cannot be replayed as a login. The same reason passwords are not stored in the clear, except
 * here there is no password at all -- Google vouches for the identity.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { GoogleIdentity } from './googleToken.ts';
import type { StoredEntitlement } from './entitlements.ts';

/** How long a musician stays signed in. Long on purpose: re-authenticating at rehearsal is hostile. */
export const SESSION_DAYS = 90;
/** The free run at the full band, granted once per account and never again. */
export const TRIAL_DAYS = 30;

export interface Account {
  id: string;
  email: string;
  name: string | null;
}

export interface SignInResult {
  account: Account;
  /** The raw token to put in the cookie. It is never stored and cannot be recovered later. */
  token: string;
  expiresAt: Date;
  /** True the first time this person signs in, which is when the trial starts. */
  isNew: boolean;
}

/** Runs one SQL statement. Injected so this module has no opinion on how the database is reached. */
export type Query = <T extends Record<string, unknown>>(text: string, params?: unknown[]) => Promise<T[]>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  // 32 bytes of randomness: far beyond guessing, and short enough for a cookie
  return randomBytes(32).toString('base64url');
}

export function createAccounts(query: Query, now: () => number = Date.now) {
  /** Finds or creates the account behind a verified Google identity, then opens a session. */
  async function signIn(identity: GoogleIdentity): Promise<SignInResult> {
    const nowMs = now();
    const existing = await query<{ id: string; email: string; name: string | null }>(
      'select id, email, name from accounts where google_sub = $1',
      [identity.sub]
    );

    let account: Account;
    let isNew = false;

    if (existing.length) {
      account = existing[0];
      // Someone can change their Google name or address; keep ours in step
      if (account.email !== identity.email || account.name !== identity.name) {
        await query('update accounts set email = $2, name = $3 where id = $1', [account.id, identity.email, identity.name]);
        account = { ...account, email: identity.email, name: identity.name };
      }
    } else {
      const id = randomUUID();
      await query('insert into accounts (id, google_sub, email, name) values ($1, $2, $3, $4)', [
        id,
        identity.sub,
        identity.email,
        identity.name,
      ]);
      // The trial is written once, at creation. Signing out and back in cannot restart it.
      await query('insert into entitlements (account_id, trial_ends_at) values ($1, $2)', [
        id,
        new Date(nowMs + TRIAL_DAYS * 86_400_000),
      ]);
      account = { id, email: identity.email, name: identity.name };
      isNew = true;
    }

    const token = newToken();
    const expiresAt = new Date(nowMs + SESSION_DAYS * 86_400_000);
    await query('insert into sessions (token_hash, account_id, expires_at) values ($1, $2, $3)', [
      hashToken(token),
      account.id,
      expiresAt,
    ]);

    return { account, token, expiresAt, isNew };
  }

  /** The account behind a cookie, or null when the token is unknown or expired. */
  async function fromToken(token: string | undefined): Promise<Account | null> {
    if (!token) return null;
    const rows = await query<{ id: string; email: string; name: string | null; expires_at: Date }>(
      `select a.id, a.email, a.name, s.expires_at
         from sessions s join accounts a on a.id = s.account_id
        where s.token_hash = $1`,
      [hashToken(token)]
    );
    if (!rows.length) return null;
    // Checked here as well as swept in the background, so an expired row is never honoured
    if (new Date(rows[0].expires_at).getTime() <= now()) return null;
    return { id: rows[0].id, email: rows[0].email, name: rows[0].name };
  }

  async function signOut(token: string | undefined): Promise<void> {
    if (!token) return;
    await query('delete from sessions where token_hash = $1', [hashToken(token)]);
  }

  /** Reads the entitlement row for the gate. Returns null when the account has none. */
  async function entitlementOf(accountId: string): Promise<StoredEntitlement | null> {
    const rows = await query<{ trial_ends_at: Date | null; paid_until: Date | null }>(
      'select trial_ends_at, paid_until from entitlements where account_id = $1',
      [accountId]
    );
    if (!rows.length) return null;
    return {
      trialEndsAt: rows[0].trial_ends_at ? new Date(rows[0].trial_ends_at) : null,
      paidUntil: rows[0].paid_until ? new Date(rows[0].paid_until) : null,
    };
  }

  /** Housekeeping, so the table does not grow with sessions nobody can use any more. */
  async function sweepExpiredSessions(): Promise<void> {
    await query('delete from sessions where expires_at <= now()');
  }

  return { signIn, fromToken, signOut, entitlementOf, sweepExpiredSessions };
}
