import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@pulse/contracts';
import {
  and,
  appUser,
  authSession,
  eq,
  inArray,
  isNull,
  sql,
  withCampus,
  type Database,
  type Transaction,
} from '@pulse/db';
import type { Env } from '../config/env.js';
import { DATABASE } from '../db/db.module.js';
import {
  accessKey,
  hashRefreshToken,
  makeRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from './auth-tokens.js';

/** The user behind a request, plus the session it came from */
export type SignedInUser = AuthUser & { sessionId: string };

export type SessionTokens = { accessToken: string; refreshToken: string };

/** Accounts that may sign in and stay signed in; suspended and deleted ones may not. */
export const SIGN_IN_STATUSES: readonly AuthUser['status'][] = ['pending_profile', 'active'];

const userColumns = {
  id: appUser.id,
  campusId: appUser.campusId,
  email: appUser.email,
  role: appUser.role,
  status: appUser.status,
};

/** Starts, checks and ends sign-in sessions (one auth_session row per refresh token). */
@Injectable()
export class SessionService {
  private readonly key: Uint8Array;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    config: ConfigService<Env, true>,
  ) {
    this.key = accessKey(config.get('JWT_SECRET', { infer: true }));
  }

  /** Runs inside verify's transaction, so a new user and their first session commit together. */
  async start(
    tx: Transaction,
    user: AuthUser,
    ipHash: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    const refreshToken = makeRefreshToken(user.campusId);

    const [row] = await tx
      .insert(authSession)
      .values({
        campusId: user.campusId,
        userId: user.id,
        familyId: randomUUID(),
        tokenHash: hashRefreshToken(refreshToken),
        ipHash,
        userAgent: userAgent?.slice(0, 200),
        // The same clock and interval the 30-day check uses, so it can never land past it
        expiresAt: sql`now() + interval '30 days'`,
      })
      .returning({ id: authSession.id });

    if (!row) {
      throw new Error('auth_session insert returned no row');
    }

    const accessToken = await signAccessToken(this.key, {
      userId: user.id,
      campusId: user.campusId,
      sessionId: row.id,
      role: user.role,
    });

    return { accessToken, refreshToken };
  }

  /** The user for an access token or undefined once the session is signed out or the user blocked */
  async authenticate(accessToken: string): Promise<SignedInUser | undefined> {
    const claims = await verifyAccessToken(this.key, accessToken);

    if (!claims) {
      return undefined;
    }

    const [user] = await withCampus(this.db, claims.campusId, (tx) =>
      tx
        .select(userColumns)
        .from(authSession)
        .innerJoin(appUser, eq(appUser.id, authSession.userId))
        .where(
          and(
            eq(authSession.id, claims.sessionId),
            eq(authSession.userId, claims.userId),
            isNull(authSession.revokedAt),
            sql`${authSession.expiresAt} > now()`,
            inArray(appUser.status, [...SIGN_IN_STATUSES]),
          ),
        )
        .limit(1),
    );
    return user ? { ...user, sessionId: claims.sessionId } : undefined;
  }

  async signOut(user: SignedInUser): Promise<void> {
    await withCampus(this.db, user.campusId, (tx) =>
      tx
        .update(authSession)
        .set({ revokedAt: sql`now()`, revokeReason: 'sign_out' })
        // Already revoked is fine; the guard trigger refuses touching a revoked row again
        .where(and(eq(authSession.id, user.sessionId), isNull(authSession.revokedAt))),
    );
  }
}
