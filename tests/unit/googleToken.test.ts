/**
 * Signs real tokens with a throwaway key pair and checks that every way of faking one is refused.
 * Nothing here reaches Google: the key set is injected, so these run offline and deterministically.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyGoogleIdToken } from '../../server/googleToken.ts';

const CLIENT_ID = '1234.apps.googleusercontent.com';
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const nowSec = Math.floor(NOW / 1000);

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify']
);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const keys = [{ kid: 'test-key', kty: 'RSA', alg: 'RS256', n: publicJwk.n!, e: publicJwk.e! }];
const fetchKeys = async () => keys;

/** Builds a token signed with the test key, overriding whatever the case needs. */
async function makeToken(payload: Record<string, unknown> = {}, header: Record<string, unknown> = {}, signWith = keyPair.privateKey) {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...header }));
  const body = b64url(
    JSON.stringify({
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '109876543210',
      email: 'baterista@example.com',
      email_verified: true,
      name: 'Dario',
      iat: nowSec - 10,
      exp: nowSec + 3600,
      ...payload,
    })
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signWith,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64url(Buffer.from(signature))}`;
}

const verify = (token: string) => verifyGoogleIdToken(token, { clientId: CLIENT_ID, fetchKeys, now: () => NOW });

test('a genuine, current token yields the identity', async () => {
  const identity = await verify(await makeToken());
  assert.equal(identity.sub, '109876543210');
  assert.equal(identity.email, 'baterista@example.com');
  assert.equal(identity.name, 'Dario');
});

test('a token signed by somebody else is refused', async () => {
  const attacker = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  // Same claims, same kid, different key: only the signature check can catch this
  await assert.rejects(verify(await makeToken({}, {}, attacker.privateKey)), /Signature does not match/);
});

test('an unsigned token is refused instead of trusted', async () => {
  // The classic JWT break: claim there is no algorithm and hope the verifier skips the signature
  const head = b64url(JSON.stringify({ alg: 'none', kid: 'test-key', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: 'x', email: 'a@b.c', email_verified: true, exp: nowSec + 3600 }));
  await assert.rejects(verify(`${head}.${body}.`), /Unsupported signing algorithm/);
});

test('a token meant for another application is refused', async () => {
  // A valid Google token from any other site would otherwise log its holder in here
  await assert.rejects(verify(await makeToken({ aud: 'someone-else.apps.googleusercontent.com' })), /different application/);
});

test('issuer, expiry and future-dating are all checked', async () => {
  await assert.rejects(verify(await makeToken({ iss: 'https://evil.example' })), /Unexpected issuer/);
  await assert.rejects(verify(await makeToken({ exp: nowSec - 120 })), /expired/);
  await assert.rejects(verify(await makeToken({ iat: nowSec + 600 })), /future/);
  // A minute of clock difference between our server and Google must not lock anyone out
  const identity = await verify(await makeToken({ exp: nowSec - 30 }));
  assert.equal(identity.sub, '109876543210');
});

test('an unverified email address cannot claim an account', async () => {
  await assert.rejects(verify(await makeToken({ email_verified: false })), /has not verified/);
});

test('a token signed with a key Google does not publish is refused', async () => {
  await assert.rejects(verify(await makeToken({}, { kid: 'unknown-key' })), /does not publish/);
});

test('garbage is rejected without throwing something unreadable', async () => {
  await assert.rejects(verify('not-a-token'), /Malformed token/);
  await assert.rejects(verify(''), /Malformed token/);
});
