/**
 * Verifies the ID token Google hands the browser after a sign-in.
 *
 * This is the only thing standing between "I am this person" and an account, so it is checked in
 * full rather than merely decoded: anyone can mint a JWT that *says* it belongs to someone, and a
 * token that is simply parsed is worth nothing. Signature, issuer, audience and expiry are all
 * verified against Google's published keys.
 *
 * Uses WebCrypto, which Node provides, so there is no third-party JWT dependency to keep patched.
 */

const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
/** Tolerated difference between our clock and Google's. */
const CLOCK_SKEW_SEC = 60;

export interface GoogleIdentity {
  /** Google's permanent id for this person. Stable even if they change their email. */
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

export interface VerifyOptions {
  clientId: string;
  /** Overridable so tests can supply their own keys instead of reaching Google. */
  fetchKeys?: () => Promise<Jwk[]>;
  now?: () => number;
}

/** Backed by a plain ArrayBuffer, which is what WebCrypto accepts. */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const decoded = Buffer.from(padded, 'base64');
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  bytes.set(decoded);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(base64UrlToBytes(segment)).toString('utf8'));
}

let cachedKeys: { keys: Jwk[]; expiresAt: number } | null = null;

async function fetchGoogleKeys(): Promise<Jwk[]> {
  if (cachedKeys && Date.now() < cachedKeys.expiresAt) return cachedKeys.keys;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`Could not read Google signing keys (${res.status})`);
  const body = (await res.json()) as { keys: Jwk[] };
  // Google says how long its keys stay valid; honour it instead of guessing
  const maxAge = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1];
  cachedKeys = { keys: body.keys, expiresAt: Date.now() + (Number(maxAge) || 3600) * 1000 };
  return body.keys;
}

/** Throws with a readable reason when the token is not a genuine, current Google sign-in. */
export async function verifyGoogleIdToken(token: string, options: VerifyOptions): Promise<GoogleIdentity> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerPart, payloadPart, signaturePart] = parts;

  const header = decodeJson(headerPart) as { alg?: string; kid?: string };
  // Only RS256 is accepted. Taking the algorithm from the token itself is how JWT verification is
  // classically broken: "alg": "none" would otherwise make any signature acceptable.
  if (header.alg !== 'RS256') throw new Error(`Unsupported signing algorithm: ${header.alg}`);
  if (!header.kid) throw new Error('Token does not say which key signed it');

  const keys = await (options.fetchKeys ?? fetchGoogleKeys)();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Token was signed with a key Google does not publish');

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const signatureBytes = base64UrlToBytes(signaturePart);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signatureBytes, signed);
  if (!valid) throw new Error('Signature does not match');

  const payload = decodeJson(payloadPart) as Record<string, unknown>;
  const nowSec = Math.floor((options.now ?? Date.now)() / 1000);

  if (!VALID_ISSUERS.has(String(payload.iss))) throw new Error(`Unexpected issuer: ${payload.iss}`);
  // Without this check, a token issued for any other Google app would be accepted here
  if (payload.aud !== options.clientId) throw new Error('Token was issued for a different application');
  if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_SEC < nowSec) throw new Error('Token has expired');
  if (typeof payload.iat === 'number' && payload.iat - CLOCK_SKEW_SEC > nowSec) throw new Error('Token is dated in the future');
  if (!payload.sub) throw new Error('Token carries no account id');
  if (!payload.email) throw new Error('Token carries no email address');
  // An unverified address could belong to someone else entirely, so it cannot identify an account
  if (payload.email_verified !== true) throw new Error('Google has not verified this email address');

  return {
    sub: String(payload.sub),
    email: String(payload.email),
    emailVerified: true,
    name: payload.name ? String(payload.name) : null,
  };
}

/** Test seam: drops the cached Google keys. */
export function resetKeyCache(): void {
  cachedKeys = null;
}
