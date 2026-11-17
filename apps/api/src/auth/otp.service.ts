import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OtpRequestAccepted, OtpVerifyResult } from '@pulse/contracts';
import {
  and,
  appUser,
  arrayContains,
  campus,
  emailOtp,
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
  deriveOtpKeys,
  hashCode,
  hashSubject,
  makeCode,
  type OtpKeys,
  sameHash,
} from './otp-code.js';
import { OTP_MAILER, type OtpMailer } from './otp-mailer.js';
import { type RateLimit, RateLimiter } from './rate-limiter.js';
import { SessionService, SIGN_IN_STATUSES, type SessionTokens } from './session.service.js';

const CODE_TTL_SEC = 600;
// The email_otp CHECK allows attempts 0–5, so a code dies at exactly this many wrong tries
const MAX_WRONG_TRIES = 5;

const LIMITS = {
  requestPerEmail: { name: 'otp-request-email', max: 5, windowSec: 3600 },
  // Generous on purpose: a whole campus on Wi-Fi shares one public IP
  requestPerIp: { name: 'otp-request-ip', max: 60, windowSec: 3600 },
  verifyPerIp: { name: 'otp-verify-ip', max: 120, windowSec: 3600 },
  // Every verify counts, right or wrong, before the code is checked. A new code or another IP
  // buys no extra guesses. A guess is tried against up to 5 live codes (one per request), so
  // the worst case is 25 code-guesses an hour per address
  verifyPerEmail: { name: 'otp-verify-email', max: 5, windowSec: 3600 },
} as const satisfies Record<string, RateLimit>;

const userColumns = {
  id: appUser.id,
  campusId: appUser.campusId,
  email: appUser.email,
  role: appUser.role,
  status: appUser.status,
};

/** What a right code gives: the response body and the new session's tokens (they become cookies). */
export type SignInResult = { body: OtpVerifyResult; tokens: SessionTokens };

/** Email one-time-code sign-in: send a code, swap a right code for an app_user and a session. */
@Injectable()
export class OtpService {
  private readonly keys: OtpKeys;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    config: ConfigService<Env, true>,
    private readonly limiter: RateLimiter,
    private readonly sessions: SessionService,
    @Inject(OTP_MAILER) private readonly mailer: OtpMailer,
  ) {
    this.keys = deriveOtpKeys(config.get('OTP_PEPPER', { infer: true }));
  }

  /** Same 202 whether or not the address can sign in, so nobody can probe for accounts. */
  async request(email: string, ip: string): Promise<OtpRequestAccepted> {
    // Counted before the campus lookup: an unknown address spends the same limits, so a 429
    // never tells which addresses are real. IP first: a blocked IP must not keep spending the
    // per-email quota of every address it tries
    await this.limiter.hit(LIMITS.requestPerIp, this.hashedSubject('ip', ip));
    await this.limiter.hit(LIMITS.requestPerEmail, this.hashedSubject('email', email));

    const campusId = await this.campusFor(email);
    if (campusId) {
      const code = makeCode();
      await withCampus(this.db, campusId, (tx) =>
        tx.insert(emailOtp).values({
          campusId,
          email,
          codeHash: hashCode(this.keys, email, code),
          ipHash: this.hashedSubject('ip', ip),
          // The database clock, the one the expiry CHECK compares created_at against
          expiresAt: sql`now() + make_interval(secs => ${CODE_TTL_SEC})`,
        }),
      );
      // After the commit, so a code is never mailed for a row that was rolled back
      await this.mailer.send(email, code);
    }
    return { expiresInSec: CODE_TTL_SEC };
  }

  /** A right code signs in (and creates the user the first time). Every failure is one 400. */
  async verify(
    email: string,
    code: string,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SignInResult> {
    await this.limiter.hit(LIMITS.verifyPerIp, this.hashedSubject('ip', ip));
    await this.limiter.hit(LIMITS.verifyPerEmail, this.hashedSubject('email', email));

    const campusId = await this.campusFor(email);
    const signedIn = campusId
      ? await this.redeemCode(campusId, email, code, ip, userAgent)
      : undefined;
    if (!signedIn) {
      // One message for unknown, expired, used, locked and wrong. The time taken can still
      // differ (no live code skips the hash), but that only hints at a recent request
      throw new BadRequestException('Invalid or expired code');
    }
    return signedIn;
  }

  /** The signed-in user (created on first sign-in) and a new session, or undefined for any failure. */
  private redeemCode(
    campusId: string,
    email: string,
    code: string,
    ip: string,
    userAgent: string | undefined,
  ): Promise<SignInResult | undefined> {
    return withCampus(this.db, campusId, async (tx) => {
      // Every live code, not just the newest: someone requesting codes for this address must not
      // kill the one the owner is typing. Locked, so two verifies of one code queue here and the
      // second sees it already used
      const live = await tx
        .select({ id: emailOtp.id, codeHash: emailOtp.codeHash })
        .from(emailOtp)
        .where(
          and(
            eq(emailOtp.email, email),
            isNull(emailOtp.consumedAt),
            sql`${emailOtp.expiresAt} > now()`,
            sql`${emailOtp.attempts} < ${MAX_WRONG_TRIES}`,
          ),
        )
        .for('update');
      if (live.length === 0) return undefined;

      const ids = live.map((row) => row.id);
      const expected = hashCode(this.keys, email, code);
      // Compares every row (no early exit), so the time taken never says which code matched
      const matched = live.map((row) => sameHash(row.codeHash, expected)).includes(true);
      if (!matched) {
        // Committed with the transaction: the wrong try counts even though the answer is a 400
        await tx
          .update(emailOtp)
          .set({ attempts: sql`${emailOtp.attempts} + 1` })
          .where(inArray(emailOtp.id, ids));
        return undefined;
      }

      // All live codes go at once, so an older one can never sign in after this
      await tx
        .update(emailOtp)
        .set({ consumedAt: sql`now()` })
        .where(inArray(emailOtp.id, ids));
      const verified = await findOrCreateUser(tx, campusId, email);
      // A blocked account gets the same 400 as a wrong code, and no session
      if (!verified || !SIGN_IN_STATUSES.includes(verified.user.status)) return undefined;

      // Same transaction: a new user and their first session commit together, or neither does
      const tokens = await this.sessions.start(
        tx,
        verified.user,
        this.hashedSubject('ip', ip),
        userAgent,
      );
      return { body: verified, tokens };
    });
  }

  // Same rule as POST /campuses/lookup. A domain two campuses claim cannot pick one: unknown
  private async campusFor(email: string): Promise<string | undefined> {
    const domain = email.slice(email.lastIndexOf('@') + 1);
    const rows = await this.db
      .select({ id: campus.id })
      .from(campus)
      .where(arrayContains(campus.emailDomains, [domain]))
      .limit(2);
    return rows.length === 1 ? rows[0]?.id : undefined;
  }

  // Redis keys and ip_hash hold only this keyed hash, never the address itself
  private hashedSubject(kind: 'email' | 'ip', value: string): string {
    return hashSubject(this.keys, `${kind}:${value}`);
  }
}

// Insert decides isNew: no "exists?" SELECT first, which would race with a second sign-in.
// No ON CONFLICT DO UPDATE: sign-in never changes an existing account
async function findOrCreateUser(
  tx: Transaction,
  campusId: string,
  email: string,
): Promise<OtpVerifyResult | undefined> {
  const [created] = await tx
    .insert(appUser)
    .values({ campusId, email })
    .onConflictDoNothing({ target: appUser.email })
    .returning(userColumns);
  if (created) return { user: created, isNew: true };

  // Under RLS this finds nothing when the address belongs to a user of another campus
  const [existing] = await tx
    .select(userColumns)
    .from(appUser)
    .where(eq(appUser.email, email))
    .limit(1);
  return existing ? { user: existing, isNew: false } : undefined;
}
