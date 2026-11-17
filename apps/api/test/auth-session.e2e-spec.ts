import { Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authUserSchema, otpVerifyResultSchema } from '@pulse/contracts';
import { appUser, authSession, campus, createDb, eq, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { z } from 'zod';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { CurrentUser, Public, Roles } from '../src/auth/auth.guard.js';
import { accessKey, signAccessToken } from '../src/auth/auth-tokens.js';
import { OTP_MAILER, type OtpMailer } from '../src/auth/otp-mailer.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import type { SignedInUser } from '../src/auth/session.service.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const domain = `session-${run}.test`;
const origin = process.env.APP_ORIGIN ?? '';
// What /probe/me answers: the user the guard attached, plus their session
const signedInSchema = authUserSchema.extend({ sessionId: z.uuid(), familyId: z.uuid() });

// Routes that exist only in this test, to exercise the global guards
@Controller('probe')
class ProbeController {
  @Get('me')
  me(@CurrentUser() user: SignedInUser): SignedInUser {
    return user;
  }

  @Roles('campus_admin')
  @Get('admin')
  admin(): { ok: true } {
    return { ok: true };
  }

  @Public()
  @Post('open')
  open(): { ok: true } {
    return { ok: true };
  }
}

type SignedIn = {
  userId: string;
  accessCookie: string;
  refreshCookie: string;
  setCookie: string[];
};

describe('Sessions, cookies and guards over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  const sent: { email: string; code: string }[] = [];
  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };

  const http = () => request(app.getHttpServer());
  const cookieValue = (setCookie: string[], name: string) =>
    setCookie.find((line) => line.startsWith(`${name}=`))?.split(';')[0] ?? '';

  async function signIn(
    email = `student-${randomUUID().slice(0, 8)}@${domain}`,
  ): Promise<SignedIn> {
    await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code ?? '';
    const res = await http()
      .post('/auth/otp/verify')
      .set('Origin', origin)
      .set('User-Agent', 'e2e-browser/1.0')
      .send({ email, code })
      .expect(200);
    const setCookie = [res.headers['set-cookie'] ?? []].flat();
    return {
      userId: otpVerifyResultSchema.parse(res.body).user.id,
      accessCookie: cookieValue(setCookie, 'pulse_at'),
      refreshCookie: cookieValue(setCookie, 'pulse_rt'),
      setCookie,
    };
  }

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values({
      name: 'Session campus',
      slug: `session-${run}`,
      emailDomains: [domain],
      location: { x: 90.4274, y: 23.8223 },
      timezone: 'Asia/Dhaka',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ProbeController],
    })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      // Rate limits have their own e2e file; here they would only need a Redis container
      .overrideProvider(RateLimiter)
      .useValue({ hit: () => Promise.resolve() })
      .overrideProvider(OTP_MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  describe('POST /auth/otp/verify', () => {
    it('sets a 15-minute access cookie and a 30-day refresh cookie, both hidden from scripts', async () => {
      const { setCookie } = await signIn();
      const access = setCookie.find((line) => line.startsWith('pulse_at='));
      const refresh = setCookie.find((line) => line.startsWith('pulse_rt='));

      expect(access).toMatch(/; Max-Age=900;/);
      expect(access).toMatch(/; Path=\/;/);
      expect(access).toMatch(/; HttpOnly/);
      expect(access).toMatch(/; Secure/);
      expect(access).toMatch(/; SameSite=Lax/);

      // Sent only to /auth (refresh in PR 3), never with ordinary requests
      expect(refresh).toMatch(/; Max-Age=2592000;/);
      expect(refresh).toMatch(/; Path=\/auth;/);
      expect(refresh).toMatch(/; HttpOnly/);
      expect(refresh).toMatch(/; Secure/);
      expect(refresh).toMatch(/; SameSite=Strict/);
    });
  });

  it('gives a suspended account the usual 400 and no session', async () => {
    const email = `student-${randomUUID().slice(0, 8)}@${domain}`;
    const { userId } = await signIn(email);
    await owner.update(appUser).set({ status: 'suspended' }).where(eq(appUser.id, userId));

    await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code ?? '';
    const res = await http()
      .post('/auth/otp/verify')
      .set('Origin', origin)
      .send({ email, code })
      .expect(400);
    expect(res.headers['set-cookie']).toBeUndefined();
    // Only the session from before the suspension
    const sessions = await owner.select().from(authSession).where(eq(authSession.userId, userId));
    expect(sessions).toHaveLength(1);
  });

  describe('AuthGuard', () => {
    it('lets a signed-in request through and knows who it is', async () => {
      const { userId, accessCookie } = await signIn();
      const res = await http().get('/probe/me').set('Cookie', accessCookie).expect(200);
      expect(signedInSchema.parse(res.body)).toMatchObject({
        id: userId,
        role: 'student',
        status: 'pending_profile',
      });
    });

    it.each([
      ['no cookie', undefined],
      ['a garbage cookie', 'pulse_at=not-a-token'],
      ['the refresh token in the access cookie', 'pulse_at=00000000-0000-0000-0000-000000000000.x'],
    ])('answers 401 to %s', async (_, cookie) => {
      const req = http().get('/probe/me');
      await (cookie ? req.set('Cookie', cookie) : req).expect(401);
    });

    it('answers 401 to a correctly signed but expired token', async () => {
      const { userId, accessCookie } = await signIn();
      const res = await http().get('/probe/me').set('Cookie', accessCookie).expect(200);
      const me = signedInSchema.parse(res.body);
      const key = accessKey(process.env.JWT_SECRET ?? '');
      const sixteenMinutesAgo = new Date(Date.now() - 16 * 60_000);
      const expired = await signAccessToken(
        key,
        { userId, campusId: me.campusId, sessionId: me.sessionId, role: 'student' },
        sixteenMinutesAgo,
      );
      await http().get('/probe/me').set('Cookie', `pulse_at=${expired}`).expect(401);
    });

    it('locks out a suspended user at once, without waiting for the token to expire', async () => {
      const { userId, accessCookie } = await signIn();
      await http().get('/probe/me').set('Cookie', accessCookie).expect(200);
      await owner.update(appUser).set({ status: 'suspended' }).where(eq(appUser.id, userId));
      await http().get('/probe/me').set('Cookie', accessCookie).expect(401);
    });

    it('leaves @Public() routes open, like the campus list', async () => {
      await http().get('/campuses').expect(200);
      await http().get('/health').expect(200);
    });
  });

  describe('@Roles', () => {
    it('reads the role from the database, not from the token', async () => {
      const { userId, accessCookie } = await signIn();
      await http().get('/probe/admin').set('Cookie', accessCookie).expect(403);

      // Same token (it still says "student"); the database now says campus_admin
      await owner.update(appUser).set({ role: 'campus_admin' }).where(eq(appUser.id, userId));
      await http().get('/probe/admin').set('Cookie', accessCookie).expect(200);
    });

    it('answers 401, not 403, when nobody is signed in', async () => {
      await http().get('/probe/admin').expect(401);
    });
  });

  describe('POST /auth/sign-out', () => {
    it('ends this session at once and clears both cookies', async () => {
      const { accessCookie } = await signIn();
      const res = await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', accessCookie)
        .expect(204);

      const cleared = [res.headers['set-cookie'] ?? []].flat();
      expect(cleared.find((line) => line.startsWith('pulse_at=;'))).toMatch(
        /Expires=Thu, 01 Jan 1970/,
      );
      expect(cleared.find((line) => line.startsWith('pulse_rt=;'))).toMatch(/Path=\/auth/);
      await http().get('/probe/me').set('Cookie', accessCookie).expect(401);
    });

    it('signs out only this device', async () => {
      const email = `student-${randomUUID().slice(0, 8)}@${domain}`;
      const laptop = await signIn(email);
      const phone = await signIn(email);
      expect(phone.userId).toBe(laptop.userId);

      await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', laptop.accessCookie)
        .expect(204);
      await http().get('/probe/me').set('Cookie', laptop.accessCookie).expect(401);
      await http().get('/probe/me').set('Cookie', phone.accessCookie).expect(200);
    });

    // Public since PR 3: a browser whose access token expired must still be able to sign out
    it('answers 204 and clears the cookies even when nobody is signed in', async () => {
      const res = await http().post('/auth/sign-out').set('Origin', origin).expect(204);
      expect([res.headers['set-cookie'] ?? []].flat()).toHaveLength(2);
    });
  });

  describe('OriginGuard', () => {
    it.each([
      ['no Origin', undefined],
      ['another site', 'https://evil.example'],
      ['the right host on another port', 'http://localhost:6666'],
    ])('refuses a POST from %s with 403, even on a public route', async (_, from) => {
      const req = http().post('/probe/open');
      await (from ? req.set('Origin', from) : req).expect(403);
    });

    it('protects signed-in routes too: a cross-site POST with a valid cookie changes nothing', async () => {
      const { accessCookie } = await signIn();
      await http()
        .post('/auth/sign-out')
        .set('Origin', 'https://evil.example')
        .set('Cookie', accessCookie)
        .expect(403);
      await http().get('/probe/me').set('Cookie', accessCookie).expect(200);
    });

    // Runs before AuthGuard: a cross-site request is refused before any session lookup
    it('answers 403, not 401, to a cross-site POST without a cookie', async () => {
      await http().post('/auth/sign-out').set('Origin', 'https://evil.example').expect(403);
    });

    it('lets a POST from the app through', async () => {
      await http().post('/probe/open').set('Origin', origin).expect(201);
    });

    it('does not ask a GET for an Origin', async () => {
      await http().get('/campuses').expect(200);
    });
  });
});
