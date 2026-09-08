// A minimal HS256 JWT implementation using the Web Crypto API, which
// is natively available in Cloudflare Workers (no npm dependency
// needed, unlike Node's `jsonwebtoken`).
//
// The enrollment "record" IS this token. It's created in
// create-enrollment, embedded in the SignWell redirect URL, and
// verified again in /api/pay once signing is done. No database
// required for this MVP — see the README for how to add real storage
// later if you outgrow this.

const EXPIRY_SECONDS = 24 * 60 * 60; // 24h

function toBase64Url(bytes) {
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signEnrollment(payload, secret) {
  if (!secret) throw new Error('TOKEN_SECRET is not configured.');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const fullPayload = { ...payload, iat: now, exp: now + EXPIRY_SECONDS };

  const headerB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput));
  const sigB64 = toBase64Url(new Uint8Array(signature));

  return `${signingInput}.${sigB64}`;
}

export async function verifyEnrollment(token, secret) {
  if (!secret) throw new Error('TOKEN_SECRET is not configured.');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const [headerB64, payloadB64, sigB64] = parts;

  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    fromBase64Url(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`)
  );
  if (!valid) throw new Error('Invalid token signature.');

  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error('Token expired.');
  }
  return payload;
}
