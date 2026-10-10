/**
 * Runs the account logic against a stand-in for the database that records every statement.
 *
 * This pins down the behaviour -- that the trial is granted once, that the raw token never reaches
 * storage, that an expired session is refused. It does NOT prove the SQL is valid: that is only
 * settled the first time the server runs against the real Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAccounts, hashToken, TRIAL_DAYS, SESSION_DAYS } from '../../server/accounts.ts';
import type { GoogleIdentity } from '../../server/googleToken.ts';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const DAY = 86_400_000;

const identity: GoogleIdentity = {
  sub: 'google-sub-123',
  email: 'baterista@example.com',
  emailVerified: true,
  name: 'Dario',
};

/** Answers each statement from a canned script and keeps the log for inspection. */
function fakeDb(responses: Record<string, unknown[][]> = {}) {
  const log: { text: string; params: unknown[] }[] = [];
  const pending = { ...responses };
  const query = async <T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> => {
    log.push({ text: text.replace(/\s+/g, ' ').trim(), params });
    for (const key of Object.keys(pending)) {
      if (text.includes(key)) return (pending[key].shift() ?? []) as T[];
    }
    return [];
  };
  const find = (fragment: string) => log.filter((e) => e.text.includes(fragment));
  return { query, log, find };
}

test('a first sign-in creates the account and starts the 30-day trial exactly once', async () => {
  const db = fakeDb();
  const accounts = createAccounts(db.query, () => NOW);

  const first = await accounts.signIn(identity);
  assert.equal(first.isNew, true);
  assert.equal(first.account.email, 'baterista@example.com');

  const trial = db.find('insert into entitlements');
  assert.equal(trial.length, 1, 'the trial row is written once');
  assert.equal((trial[0].params[1] as Date).getTime(), NOW + TRIAL_DAYS * DAY);

  // Signing in again finds the existing account and must not write a second trial
  const db2 = fakeDb({ 'from accounts where google_sub': [[{ id: 'acc-1', email: identity.email, name: identity.name }]] });
  const accounts2 = createAccounts(db2.query, () => NOW + 60 * DAY);
  const second = await accounts2.signIn(identity);
  assert.equal(second.isNew, false);
  assert.equal(db2.find('insert into entitlements').length, 0, 'signing out and back in cannot restart the trial');
});

test('the raw session token never reaches storage, only its hash', async () => {
  const db = fakeDb();
  const accounts = createAccounts(db.query, () => NOW);
  const { token, expiresAt } = await accounts.signIn(identity);

  assert.ok(token.length >= 40, 'the token carries real randomness');
  assert.equal(expiresAt.getTime(), NOW + SESSION_DAYS * DAY);

  const stored = db.find('insert into sessions')[0];
  const storedHash = stored.params[0] as string;
  assert.equal(storedHash, createHash('sha256').update(token).digest('hex'));
  assert.notEqual(storedHash, token);

  // Nothing written anywhere may contain the token itself
  const everything = JSON.stringify(db.log);
  assert.ok(!everything.includes(token), 'the token appears in no statement at all');
});

test('two sign-ins never produce the same token', async () => {
  const db = fakeDb();
  const accounts = createAccounts(db.query, () => NOW);
  const a = await accounts.signIn(identity);
  const b = await accounts.signIn(identity);
  assert.notEqual(a.token, b.token);
});

test('a live session resolves to its account; an expired one does not', async () => {
  const row = { id: 'acc-1', email: identity.email, name: 'Dario' };
  const live = fakeDb({ 'from sessions s join accounts a': [[{ ...row, expires_at: new Date(NOW + DAY) }]] });
  const liveAccounts = createAccounts(live.query, () => NOW);
  assert.equal((await liveAccounts.fromToken('a-token'))?.id, 'acc-1');
  // The lookup must go by hash, never by the token itself
  assert.equal(live.find('from sessions')[0].params[0], hashToken('a-token'));

  const stale = fakeDb({ 'from sessions s join accounts a': [[{ ...row, expires_at: new Date(NOW - 1) }]] });
  const staleAccounts = createAccounts(stale.query, () => NOW);
  assert.equal(await staleAccounts.fromToken('a-token'), null, 'an expired row is refused, not honoured');

  const none = fakeDb();
  assert.equal(await createAccounts(none.query, () => NOW).fromToken('unknown'), null);
  assert.equal(await createAccounts(none.query, () => NOW).fromToken(undefined), null);
});

test('signing out deletes only that session, by hash', async () => {
  const db = fakeDb();
  await createAccounts(db.query, () => NOW).signOut('the-token');
  const del = db.find('delete from sessions')[0];
  assert.equal(del.params[0], hashToken('the-token'));

  const noop = fakeDb();
  await createAccounts(noop.query, () => NOW).signOut(undefined);
  assert.equal(noop.log.length, 0, 'no cookie means nothing to delete');
});

test('a changed Google name or address updates the account instead of duplicating it', async () => {
  const db = fakeDb({ 'from accounts where google_sub': [[{ id: 'acc-1', email: 'viejo@example.com', name: 'Viejo' }]] });
  const accounts = createAccounts(db.query, () => NOW);
  const result = await accounts.signIn(identity);

  assert.equal(result.account.email, 'baterista@example.com');
  assert.equal(db.find('insert into accounts').length, 0, 'the same person must not get a second account');
  assert.deepEqual(db.find('update accounts')[0].params, ['acc-1', 'baterista@example.com', 'Dario']);
});

test('the entitlement row is read as dates the gate can compare', async () => {
  const db = fakeDb({
    'from entitlements': [[{ trial_ends_at: new Date(NOW + 10 * DAY).toISOString(), paid_until: null }]],
  });
  const accounts = createAccounts(db.query, () => NOW);
  const stored = await accounts.entitlementOf('acc-1');
  assert.equal(stored?.trialEndsAt?.getTime(), NOW + 10 * DAY);
  assert.equal(stored?.paidUntil, null);

  const empty = fakeDb();
  assert.equal(await createAccounts(empty.query, () => NOW).entitlementOf('acc-1'), null);
});
