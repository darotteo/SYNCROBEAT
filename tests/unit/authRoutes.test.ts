/**
 * Drives the three sign-in endpoints over real HTTP against fake dependencies: no database, no
 * Google, no production-only switches in the code under test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { mountAuth, readCookie, SESSION_COOKIE } from '../../server/authRoutes.ts';
import type { GoogleIdentity } from '../../server/googleToken.ts';

const identity: GoogleIdentity = { sub: 'g-1', email: 'dario@example.com', emailVerified: true, name: 'Dario' };
const account = { id: 'acc-1', email: identity.email, name: identity.name };

interface Overrides {
  verifyToken?: (credential: string) => Promise<GoogleIdentity>;
  signIn?: () => Promise<{ account: typeof account; token: string; expiresAt: Date; isNew: boolean }>;
  fromToken?: (token: string | undefined) => Promise<typeof account | null>;
  signOut?: (token: string | undefined) => Promise<void>;
  entitlementOf?: () => Promise<{ plan: 'free' | 'pro'; until: Date | null; source: 'db' | 'cache' | 'unverified' }>;
}

/** Starts the routes on an ephemeral port and returns a fetch bound to it. */
async function serve(overrides: Overrides = {}) {
  const signedOut: (string | undefined)[] = [];
  const app = express();
  mountAuth(app, {
    verifyToken: overrides.verifyToken ?? (async () => identity),
    accounts: {
      signIn: overrides.signIn ?? (async () => ({ account, token: 'tok-abc', expiresAt: new Date(Date.now() + 86_400_000), isNew: true })),
      fromToken: overrides.fromToken ?? (async (t) => (t === 'tok-abc' ? account : null)),
      signOut: overrides.signOut ?? (async (t) => void signedOut.push(t)),
    },
    entitlementOf: overrides.entitlementOf ?? (async () => ({ plan: 'pro', until: null, source: 'db' })),
    isProduction: false,
  });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    call: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init),
    signedOut,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test('a valid credential opens a session and sets an HttpOnly cookie', async () => {
  const s = await serve();
  const res = await s.call('/api/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'from-google' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account.email, 'dario@example.com');
  assert.equal(body.plan, 'pro');
  assert.equal(body.isNew, true);

  const cookie = res.headers.get('set-cookie') ?? '';
  assert.match(cookie, /sb_session=tok-abc/);
  // Without HttpOnly, any injected script on the page could read the session and impersonate them
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  await s.close();
});

test('a credential Google will not vouch for is refused without explaining why', async () => {
  const s = await serve({
    verifyToken: async () => {
      throw new Error('Signature does not match');
    },
  });
  const res = await s.call('/api/auth/google', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'forged' }),
  });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(res.headers.get('set-cookie'), null, 'no session is opened');
  // Naming the failed check would tell an attacker exactly what to fix next
  assert.ok(!JSON.stringify(body).includes('Signature'), 'the internal reason stays in the log');
  await s.close();
});

test('a missing or malformed credential is a plain 400', async () => {
  const s = await serve();
  for (const body of ['{}', '{"credential":""}', '{"credential":123}']) {
    const res = await s.call('/api/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(res.status, 400, `rejected: ${body}`);
  }
  await s.close();
});

test('me reports the account for a live cookie and nobody without one', async () => {
  const s = await serve();
  const anon = await (await s.call('/api/auth/me')).json();
  assert.equal(anon.account, null);
  assert.equal(anon.plan, 'free', 'no session means the free plan, never an error');

  const mine = await (await s.call('/api/auth/me', { headers: { cookie: `${SESSION_COOKIE}=tok-abc` } })).json();
  assert.equal(mine.account.id, 'acc-1');
  assert.equal(mine.plan, 'pro');

  const stale = await (await s.call('/api/auth/me', { headers: { cookie: `${SESSION_COOKIE}=expired` } })).json();
  assert.equal(stale.account, null);
  await s.close();
});

test('a database outage on me answers free and degraded rather than failing the page', async () => {
  const s = await serve({
    fromToken: async () => {
      throw new Error('connection refused');
    },
  });
  const res = await s.call('/api/auth/me', { headers: { cookie: `${SESSION_COOKIE}=tok-abc` } });
  assert.equal(res.status, 200, 'the app must still load during an outage');
  const body = await res.json();
  assert.equal(body.degraded, true);
  await s.close();
});

test('logging out clears the cookie even when the row cannot be deleted', async () => {
  const s = await serve({
    signOut: async () => {
      throw new Error('connection refused');
    },
  });
  const res = await s.call('/api/auth/logout', { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=tok-abc` } });
  assert.equal(res.status, 200);
  // Asking to sign out must always end with this browser signed out
  assert.match(res.headers.get('set-cookie') ?? '', /sb_session=;/);
  await s.close();
});

test('logout passes the token from the cookie, not something else', async () => {
  const s = await serve();
  await s.call('/api/auth/logout', { method: 'POST', headers: { cookie: `other=x; ${SESSION_COOKIE}=tok-abc; more=y` } });
  assert.deepEqual(s.signedOut, ['tok-abc']);
  await s.close();
});

test('cookie parsing picks the right value out of a crowded header', () => {
  assert.equal(readCookie('a=1; sb_session=xyz; b=2', 'sb_session'), 'xyz');
  assert.equal(readCookie('sb_session=xyz', 'sb_session'), 'xyz');
  assert.equal(readCookie('sb_session_other=no', 'sb_session'), undefined, 'a longer name must not match');
  assert.equal(readCookie('', 'sb_session'), undefined);
  assert.equal(readCookie(undefined, 'sb_session'), undefined);
  assert.equal(readCookie('sb_session=a%20b', 'sb_session'), 'a b');
});
