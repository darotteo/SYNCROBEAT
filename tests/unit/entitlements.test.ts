/**
 * The behaviour these tests pin down is a business decision, not an implementation detail: when the
 * database cannot answer, a rehearsal keeps going. See the note at the top of server/entitlements.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntitlements, planFor } from '../../server/entitlements.ts';

const DAY = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

test('a trial and a payment both grant Pro, and the later one wins', () => {
  assert.equal(planFor(null, NOW).plan, 'free', 'no row means the free duo');
  assert.equal(planFor({ trialEndsAt: null, paidUntil: null }, NOW).plan, 'free');

  const onTrial = planFor({ trialEndsAt: new Date(NOW + 10 * DAY), paidUntil: null }, NOW);
  assert.equal(onTrial.plan, 'pro');
  assert.equal(onTrial.until?.getTime(), NOW + 10 * DAY);

  // Paying halfway through a trial must not cut the trial short
  const both = planFor({ trialEndsAt: new Date(NOW + 20 * DAY), paidUntil: new Date(NOW + 5 * DAY) }, NOW);
  assert.equal(both.until?.getTime(), NOW + 20 * DAY, 'the longer of the two is what counts');

  const lapsed = planFor({ trialEndsAt: new Date(NOW - DAY), paidUntil: new Date(NOW - 1) }, NOW);
  assert.equal(lapsed.plan, 'free', 'expired dates drop back to free');
});

test('a successful lookup is cached, and the cache still lets the entitlement lapse', async () => {
  let calls = 0;
  let clock = NOW;
  const e = createEntitlements({
    load: async () => {
      calls++;
      return { trialEndsAt: new Date(NOW + 30_000), paidUntil: null };
    },
    now: () => clock,
    ttlMs: 60_000,
  });

  assert.equal((await e.get('a')).plan, 'pro');
  assert.equal((await e.get('a')).plan, 'pro');
  assert.equal(calls, 1, 'the second check inside the TTL does not hit the database');

  // Still inside the TTL, but the trial itself ran out in the meantime
  clock = NOW + 40_000;
  const lapsed = await e.get('a');
  assert.equal(lapsed.plan, 'free', 'a cached answer must not outlive its own expiry date');
  assert.equal(calls, 1);
});

test('when the database is down, the last good answer is reused instead of cutting anyone off', async () => {
  let fail = false;
  let clock = NOW;
  const e = createEntitlements({
    load: async () => {
      if (fail) throw new Error('connection refused');
      return { trialEndsAt: null, paidUntil: new Date(NOW + 30 * DAY) };
    },
    now: () => clock,
    ttlMs: 1_000,
  });

  assert.equal((await e.get('host')).source, 'db');

  fail = true;
  clock = NOW + 5_000; // past the TTL, so this one really does try the database
  const during = await e.get('host');
  assert.equal(during.plan, 'pro', 'a paying band keeps playing through an outage');
  assert.equal(during.source, 'cache');

  // The cached answer is kept however long the outage lasts, but it still expires on its own date
  clock = NOW + 31 * DAY;
  const afterExpiry = await e.get('host');
  assert.equal(afterExpiry.plan, 'free', 'the subscription ran out, outage or not');
  assert.equal(afterExpiry.source, 'cache');
});

test('an account we have never seen is let in during an outage, not blocked', async () => {
  const e = createEntitlements({
    load: async () => {
      throw new Error('connection refused');
    },
    now: () => NOW,
  });

  const unknown = await e.get('first-timer');
  assert.equal(unknown.plan, 'pro', 'our own outage must not stop a rehearsal');
  assert.equal(unknown.source, 'unverified', 'but we record that we never actually checked');
});

test('a free account stays free during an outage: failing open is for lookups, not for downgrades', async () => {
  let fail = false;
  const e = createEntitlements({
    load: async () => {
      if (fail) throw new Error('down');
      return { trialEndsAt: new Date(NOW - DAY), paidUntil: null }; // trial already over
    },
    now: () => NOW,
    ttlMs: 0,
  });

  assert.equal((await e.get('expired')).plan, 'free');
  fail = true;
  const during = await e.get('expired');
  assert.equal(during.plan, 'free', 'an outage is not a free upgrade for someone we know is free');
  assert.equal(during.source, 'cache');
});

test('invalidate forces a fresh read, so a payment is visible immediately', async () => {
  let paid = false;
  const e = createEntitlements({
    load: async () => ({ trialEndsAt: null, paidUntil: paid ? new Date(NOW + 30 * DAY) : null }),
    now: () => NOW,
    ttlMs: 60_000,
  });

  assert.equal((await e.get('buyer')).plan, 'free');
  paid = true;
  assert.equal((await e.get('buyer')).plan, 'free', 'without invalidating, the TTL still applies');
  e.invalidate('buyer');
  assert.equal((await e.get('buyer')).plan, 'pro', 'after the webhook lands, the next check sees it');
});
