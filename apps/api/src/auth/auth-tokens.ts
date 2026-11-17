import { userRoleSchema } from '@pulse/contracts';
import { jwtVerify, SignJWT } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/** Time limits of tokens */
export const ACCESS_TOKEN_TTL_SEC = 15 * 60;
export const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

/** Who an access token was issued to. Guards still read role and status from the database. */
export type AccessClaims = {
  userId: string;
  campusId: string;
  sessionId: string;
  role: z.infer<typeof userRoleSchema>;
};

const payloadSchema = z.object({
  sub: z.uuid(),
  campusId: z.uuid(),
  sid: z.uuid(),
  role: userRoleSchema,
});

const refreshTokenPattern = /^([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}$/;

/** The signing key from JWT_SECRET, made once at boot. */
export function accessKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export function signAccessToken(
  key: Uint8Array,
  claims: AccessClaims,
  now = new Date(),
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    campusId: claims.campusId,
    sid: claims.sessionId,
    role: claims.role,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + ACCESS_TOKEN_TTL_SEC)
    .sign(key);
}

/**
 * The claims of a valid signed token or undefined for anything else. toleranceSec accepts a
 * token that long past its expiry (sign-out only: it needs to know the device, not trust it).
 */
export async function verifyAccessToken(
  key: Uint8Array,
  token: string,
  now = new Date(),
  toleranceSec = 0,
): Promise<AccessClaims | undefined> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
      currentDate: now,
      clockTolerance: toleranceSec,
    });
    const parsed = payloadSchema.safeParse(payload);

    if (!parsed.success) {
      return undefined;
    }

    const { sub, campusId, sid, role } = parsed.data;
    return { userId: sub, campusId, sessionId: sid, role };
  } catch {
    return undefined;
  }
}

/** The campus comes first so refresh knows where to look: RLS hides every other campus. */
export function makeRefreshToken(campusId: string): string {
  return `${campusId}.${randomBytes(32).toString('base64url')}`;
}

export function campusOfRefreshToken(token: string): string | undefined {
  const campusId = refreshTokenPattern.exec(token)?.[1];
  return campusId && z.uuid().safeParse(campusId).success ? campusId : undefined;
}

/** Plain SHA-256 is enough here: 256 random bits cannot be guessed back from the hash. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
