import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthSessionList, AuthUser } from '@pulse/contracts';
import {
  and,
  appUser,
  authSession,
  desc,
  eq,
  inArray,
  isNull,
  sql,
  withCampus,
  type Database,
  type SQL,
  type Transaction,
} from '@pulse/db';
import type { Env } from '../config/env.js';
import { DATABASE } from '../db/db.module.js';
import {
  accessKey,
  campusOfRefreshToken,
  hashRefreshToken,
  makeRefreshToken,
  REFRESH_TOKEN_TTL_SEC,
  signAccessToken,
  verifyAccessToken,
} from './auth-tokens.js';

/**
 * The user behind a request. familyId is the device, the id /auth/sessions uses; sessionId is
 * the current auth_session row and changes on every refresh.
 */
export type SignedInUser = AuthUser & { sessionId: string; familyId: string };

export type SessionTokens = { accessToken: string; refreshToken: string };

/** Accounts that may sign in and stay signed in; suspended and deleted ones may not. */
export const SIGN_IN_STATUSES: readonly AuthUser['status'][] = ['pending_profile', 'active'];

// Two tabs refreshing at once: the loser presents a token rotated a moment ago. Inside this
// window that is a plain 401 (it retries with the cookie the winner set); after it, theft
const REUSE_GRACE_SEC = 10;

type RevokeReason = NonNullable<typeof authSession.$inferSelect.revokeReason>;

const userColumns = {
  id: appUser.id,
  campusId: appUser.campusId,
  email: appUser.email,
  role: appUser.role,
  status: appUser.status,
};

/**
 * Starts, refreshes, lists and ends sign-in sessions. Each refresh adds an auth_session row;
 * all rows of one device share a family_id, and the API calls that family a session.
 */
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
  start(
    tx: Transaction,
    user: AuthUser,
    ipHash: string,
    userAgent: string | undefined,
  ): Promise<SessionTokens> {
    return this.issue(tx, user, {
      familyId: randomUUID(),
      ipHash,
      userAgent: userAgent?.slice(0, 200) ?? null,
    });
  }

  /** New tokens for a live refresh token, or undefined (401) for anything else. */
  async refresh(refreshToken: string | undefined): Promise<SessionTokens | undefined> {
    const campusId = refreshToken ? campusOfRefreshToken(refreshToken) : undefined;

    if (!refreshToken || !campusId) {
      return undefined;
    }

    return withCampus(this.db, campusId, async (tx) => {
      // Locked: a second refresh of the same token waits here, then re-reads the row and sees
      // it rotated. The user's status is checked again, so a suspended account gets nothing
      const [row] = await tx
        .select({
          user: userColumns,
          id: authSession.id,
          familyId: authSession.familyId,
          ipHash: authSession.ipHash,
          userAgent: authSession.userAgent,
          rotated: sql<boolean>`${authSession.rotatedAt} is not null`,
          inGrace: sql<boolean>`coalesce(${authSession.rotatedAt} > now() - make_interval(secs => ${REUSE_GRACE_SEC}), false)`,
        })
        .from(authSession)
        .innerJoin(appUser, eq(appUser.id, authSession.userId))
        .where(
          and(
            eq(authSession.tokenHash, hashRefreshToken(refreshToken)),
            isNull(authSession.revokedAt),
            sql`${authSession.expiresAt} > now()`,
            inArray(appUser.status, [...SIGN_IN_STATUSES]),
          ),
        )
        .for('update', { of: authSession })
        .limit(1);

      if (!row) {
        return undefined;
      }

      if (row.rotated) {
        // Returned, not thrown, so the revoke commits even though the answer is a 401
        if (!row.inGrace) {
          await revoke(
            tx,
            [eq(authSession.familyId, row.familyId), eq(authSession.userId, row.user.id)],
            'reuse_detected',
          );
        }
        return undefined;
      }

      // The guard trigger stamps the real time
      await tx
        .update(authSession)
        .set({ rotatedAt: sql`now()` })
        .where(eq(authSession.id, row.id));
      // The child keeps the parent's family, IP hash and user agent (where the device signed in)
      return this.issue(tx, row.user, {
        familyId: row.familyId,
        ipHash: row.ipHash,
        userAgent: row.userAgent,
      });
    });
  }

  /** The user for an access token or undefined once the session is signed out or the user blocked */
  async authenticate(accessToken: string): Promise<SignedInUser | undefined> {
    const claims = await verifyAccessToken(this.key, accessToken);

    if (!claims) {
      return undefined;
    }

    const [user] = await withCampus(this.db, claims.campusId, (tx) =>
      tx
        .select({ ...userColumns, familyId: authSession.familyId })
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

  /**
   * Ends the device each token belongs to. Needs no live session: an access token expired up to
   * 30 days ago still names its row by signature, and the refresh token names its row by hash.
   * Both are used: they normally name the same device, but if they ever drifted apart, the
   * device whose cookies get cleared must not stay signed in.
   */
  async signOut(tokens: Partial<SessionTokens>): Promise<void> {
    const claims = tokens.accessToken
      ? await verifyAccessToken(this.key, tokens.accessToken, new Date(), REFRESH_TOKEN_TTL_SEC)
      : undefined;

    if (claims) {
      await withCampus(this.db, claims.campusId, (tx) =>
        revokeFamilyOf(tx, [
          eq(authSession.id, claims.sessionId),
          eq(authSession.userId, claims.userId),
        ]),
      );
    }

    const campusId = tokens.refreshToken ? campusOfRefreshToken(tokens.refreshToken) : undefined;

    if (tokens.refreshToken && campusId) {
      const tokenHash = hashRefreshToken(tokens.refreshToken);
      await withCampus(this.db, campusId, (tx) =>
        revokeFamilyOf(tx, [eq(authSession.tokenHash, tokenHash)]),
      );
    }
  }

  async signOutAll(user: SignedInUser): Promise<void> {
    await withCampus(this.db, user.campusId, (tx) =>
      revoke(tx, [eq(authSession.userId, user.id)], 'sign_out_all'),
    );
  }

  /** The user's signed-in devices: the live, not yet rotated row of each family. */
  async list(user: SignedInUser): Promise<AuthSessionList> {
    const rows = await withCampus(this.db, user.campusId, (tx) =>
      tx
        .select({
          id: authSession.familyId,
          userAgent: authSession.userAgent,
          lastActiveAt: authSession.createdAt,
          expiresAt: authSession.expiresAt,
        })
        .from(authSession)
        .where(
          and(
            eq(authSession.userId, user.id),
            isNull(authSession.rotatedAt),
            isNull(authSession.revokedAt),
            sql`${authSession.expiresAt} > now()`,
          ),
        )
        .orderBy(desc(authSession.createdAt)),
    );

    return {
      sessions: rows.map((row) => ({
        id: row.id,
        userAgent: row.userAgent,
        lastActiveAt: row.lastActiveAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        current: row.id === user.familyId,
      })),
    };
  }

  /** Signs out one of the user's devices. False when they have no live device with that id. */
  async revokeDevice(user: SignedInUser, familyId: string): Promise<boolean> {
    const revoked = await withCampus(this.db, user.campusId, (tx) =>
      revoke(tx, [eq(authSession.userId, user.id), eq(authSession.familyId, familyId)], 'sign_out'),
    );
    return revoked > 0;
  }

  // One new auth_session row and the tokens that point at it
  private async issue(
    tx: Transaction,
    user: AuthUser,
    device: { familyId: string; ipHash: string; userAgent: string | null },
  ): Promise<SessionTokens> {
    const refreshToken = makeRefreshToken(user.campusId);

    const [row] = await tx
      .insert(authSession)
      .values({
        campusId: user.campusId,
        userId: user.id,
        familyId: device.familyId,
        tokenHash: hashRefreshToken(refreshToken),
        ipHash: device.ipHash,
        userAgent: device.userAgent,
        // The same clock and interval the 30-day check uses, so it can never land past it.
        // Every refresh slides it: a device in use stays signed in
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
}

/**
 * Revokes every live row matching all conditions and returns how many it revoked.
 *
 * Repeated until nothing is left: under READ COMMITTED one UPDATE sees only rows committed
 * when it started. A refresh holding a row lock makes it wait, and the child row that refresh
 * inserts is invisible to it; the next UPDATE is a new statement and sees it.
 * Skips revoked rows: the guard trigger aborts on any change to one.
 */
async function revoke(
  tx: Transaction,
  conditions: [SQL, ...SQL[]],
  reason: RevokeReason,
): Promise<number> {
  let total = 0;

  for (;;) {
    const revoked = await tx
      .update(authSession)
      .set({ revokedAt: sql`now()`, revokeReason: reason })
      .where(and(...conditions, isNull(authSession.revokedAt)))
      .returning({ id: authSession.id });

    if (revoked.length === 0) {
      return total;
    }

    total += revoked.length;
  }
}

// Any row of a device, rotated or not, names its whole family. Scoped by user as well, like
// every family revoke
async function revokeFamilyOf(tx: Transaction, row: [SQL, ...SQL[]]): Promise<void> {
  const [found] = await tx
    .select({ familyId: authSession.familyId, userId: authSession.userId })
    .from(authSession)
    .where(and(...row))
    .limit(1);

  if (found) {
    await revoke(
      tx,
      [eq(authSession.familyId, found.familyId), eq(authSession.userId, found.userId)],
      'sign_out',
    );
  }
}
