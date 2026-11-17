import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import {
  ACCESS_TOKEN_TTL_SEC,
  type AccessClaims,
  accessKey,
  campusOfRefreshToken,
  hashRefreshToken,
  makeRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './auth-tokens.js';

const key = accessKey('jwt-secret-for-unit-tests-only-0123456789abcdef');
const otherKey = accessKey('another-secret-for-unit-tests-only-0123456789ab');
const now = new Date('2026-11-17T10:00:00Z');
const claims: AccessClaims = {
  userId: randomUUID(),
  campusId: randomUUID(),
  sessionId: randomUUID(),
  role: 'student',
};
const later = (seconds: number) => new Date(now.getTime() + seconds * 1000);
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('access token', () => {
  it('gives back the same claims while it is valid', async () => {
    const token = await signAccessToken(key, claims, now);
    expect(await verifyAccessToken(key, token, now)).toEqual(claims);
    expect(await verifyAccessToken(key, token, later(ACCESS_TOKEN_TTL_SEC - 1))).toEqual(claims);
  });

  it('stops working once its 15 minutes are over', async () => {
    const token = await signAccessToken(key, claims, now);
    expect(await verifyAccessToken(key, token, later(ACCESS_TOKEN_TTL_SEC + 1))).toBeUndefined();
  });

  it('refuses a token signed with another secret', async () => {
    const token = await signAccessToken(otherKey, claims, now);
    expect(await verifyAccessToken(key, token, now)).toBeUndefined();
  });

  it('refuses a token whose claims were changed after signing', async () => {
    const [header, , signature] = (await signAccessToken(key, claims, now)).split('.');
    const forged = base64url({ ...claims, sub: claims.userId, role: 'campus_admin' });
    expect(await verifyAccessToken(key, `${header}.${forged}.${signature}`, now)).toBeUndefined();
  });

  // The classic JWT hole: "alg: none" means "trust me, no signature"
  it('refuses an unsigned token', async () => {
    const iat = Math.floor(now.getTime() / 1000);
    const payload = { sub: claims.userId, campusId: claims.campusId, sid: claims.sessionId };
    const unsigned = `${base64url({ alg: 'none' })}.${base64url({ ...payload, role: 'student', iat, exp: iat + 900 })}.`;
    expect(await verifyAccessToken(key, unsigned, now)).toBeUndefined();
  });

  it('refuses a correctly signed token that lacks our claims', async () => {
    const iat = Math.floor(now.getTime() / 1000);
    const token = await new SignJWT({ campusId: claims.campusId, role: 'student' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(key);
    expect(await verifyAccessToken(key, token, now)).toBeUndefined();
  });

  it('refuses a correctly signed token that never expires', async () => {
    const token = await new SignJWT({
      campusId: claims.campusId,
      sid: claims.sessionId,
      role: 'student',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(claims.userId)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .sign(key);
    expect(await verifyAccessToken(key, token, now)).toBeUndefined();
  });

  it.each(['', 'garbage', 'a.b.c', 'Bearer x'])('refuses %j without throwing', async (token) => {
    expect(await verifyAccessToken(key, token, now)).toBeUndefined();
  });
});

describe('refresh token', () => {
  const campusId = randomUUID();

  it('names its campus and carries 256 random bits', () => {
    const token = makeRefreshToken(campusId);
    expect(token).toMatch(new RegExp(`^${campusId}\\.[A-Za-z0-9_-]{43}$`));
    expect(makeRefreshToken(campusId)).not.toBe(token);
    expect(campusOfRefreshToken(token)).toBe(campusId);
  });

  it.each([
    '',
    'no-dot-at-all',
    `${campusId}.`,
    `${campusId}.short`,
    `not-a-uuid.${'a'.repeat(43)}`,
    `${campusId}.${'a'.repeat(43)}.extra`,
    `${campusId}.${'a'.repeat(42)}*`,
  ])('finds no campus in the malformed %j', (token) => {
    expect(campusOfRefreshToken(token)).toBeUndefined();
  });

  it('stores as 64 hex characters, the same every time', () => {
    const token = makeRefreshToken(campusId);
    expect(hashRefreshToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(makeRefreshToken(campusId))).not.toBe(hashRefreshToken(token));
  });
});
