/**
 * Decides whether a musician may run a full band or is on the free duo.
 *
 * The rule that shapes this file: **a rehearsal must never be stopped by our own infrastructure.**
 * Wrongly letting one room play for free costs a few cents; throwing a paying band out mid-song on
 * a Saturday night costs the band. So a lookup that fails falls back to the last answer we trusted,
 * and only someone we have never seen before is waved through on an outage.
 */

export type Plan = 'free' | 'pro';

export interface StoredEntitlement {
  trialEndsAt: Date | null;
  paidUntil: Date | null;
}

export interface Entitlement {
  plan: Plan;
  /** When the current entitlement runs out, if it is time-limited. */
  until: Date | null;
  /** Where the answer came from, for diagnostics and for honest UI copy. */
  source: 'db' | 'cache' | 'unverified';
}

export interface EntitlementsOptions {
  /** Reads one account's row. Resolves to null when the account has no entitlement row yet. */
  load: (accountId: string) => Promise<StoredEntitlement | null>;
  now?: () => number;
  /** How long a good answer is reused before asking the database again. */
  ttlMs?: number;
}

const FREE: Entitlement = { plan: 'free', until: null, source: 'db' };

export function planFor(stored: StoredEntitlement | null, nowMs: number): Entitlement {
  if (!stored) return FREE;
  // Whichever runs out later wins: paying during a trial must not shorten it
  const candidates = [stored.paidUntil, stored.trialEndsAt].filter((d): d is Date => d instanceof Date);
  const until = candidates.reduce<Date | null>((best, d) => (!best || d > best ? d : best), null);
  if (!until || until.getTime() <= nowMs) return FREE;
  return { plan: 'pro', until, source: 'db' };
}

export function createEntitlements({ load, now = Date.now, ttlMs = 60_000 }: EntitlementsOptions) {
  const cache = new Map<string, { entitlement: Entitlement; at: number }>();

  async function get(accountId: string): Promise<Entitlement> {
    const cached = cache.get(accountId);
    const nowMs = now();
    if (cached && nowMs - cached.at < ttlMs) {
      // Still fresh, but re-evaluate the dates: an entitlement can lapse inside the TTL
      return { ...recheck(cached.entitlement, nowMs), source: cached.entitlement.source };
    }

    try {
      const stored = await load(accountId);
      const entitlement = planFor(stored, nowMs);
      cache.set(accountId, { entitlement, at: nowMs });
      return entitlement;
    } catch {
      if (cached) {
        // Unreachable database: keep serving what it last told us, however old. Forgetting a known
        // answer would hand Pro to someone we know is on the free plan, which is the one case
        // where failing open really does give the product away. The expiry date still applies.
        return { ...recheck(cached.entitlement, nowMs), source: 'cache' };
      }
      // Never seen this account and cannot ask: let them play. See the note at the top.
      return { plan: 'pro', until: null, source: 'unverified' };
    }
  }

  /** An entitlement held in memory still expires on its own date. */
  function recheck(entitlement: Entitlement, nowMs: number): Entitlement {
    if (entitlement.plan === 'pro' && entitlement.until && entitlement.until.getTime() <= nowMs) {
      return { plan: 'free', until: null, source: entitlement.source };
    }
    return entitlement;
  }

  /** Drops a cached answer so the next check hits the database. Call it after a payment lands. */
  function invalidate(accountId: string): void {
    cache.delete(accountId);
  }

  function size(): number {
    return cache.size;
  }

  return { get, invalidate, size };
}
