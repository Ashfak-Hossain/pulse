import { describe, expect, it } from 'vitest';
import {
  otpRequestAcceptedSchema,
  otpRequestBodySchema,
  otpVerifyBodySchema,
  otpVerifyResultSchema,
} from '../src/index.js';

describe('otpRequestBodySchema', () => {
  it('lowercases the email, so one address is always one user', () => {
    expect(otpRequestBodySchema.parse({ email: 'Student@AIUB.edu' })).toEqual({
      email: 'student@aiub.edu',
    });
  });

  it.each([
    {},
    { email: 'not-an-email' },
    { email: `${'a'.repeat(250)}@aiub.edu` },
    { email: 'student@aiub.edu', turnstileToken: 'later' },
  ])('rejects %o', (body) => expect(otpRequestBodySchema.safeParse(body).success).toBe(false));
});

describe('otpVerifyBodySchema', () => {
  it('keeps leading zeros in the code', () => {
    expect(otpVerifyBodySchema.parse({ email: 'student@aiub.edu', code: '004217' }).code).toBe(
      '004217',
    );
  });

  it.each(['12345', '1234567', '12345a', ' 123456', 123456])('rejects code %o', (code) =>
    expect(otpVerifyBodySchema.safeParse({ email: 'student@aiub.edu', code }).success).toBe(false),
  );

  it('rejects unknown fields', () => {
    const body = { email: 'student@aiub.edu', code: '123456', remember: true };
    expect(otpVerifyBodySchema.safeParse(body).success).toBe(false);
  });
});

describe('responses', () => {
  it.each([0, -600, 600.5])('rejects a request answer with expiresInSec %o', (expiresInSec) =>
    expect(otpRequestAcceptedSchema.safeParse({ expiresInSec }).success).toBe(false),
  );

  it('describes the verify answer and rejects a leaked field', () => {
    const user = {
      id: '01a1c517-cf8a-7118-b504-61790070ac1a',
      campusId: 'b5bc33b9-f2eb-4d82-849f-d5605305415b',
      email: 'student@aiub.edu',
      role: 'student',
      status: 'pending_profile',
    };
    expect(otpVerifyResultSchema.parse({ user, isNew: true })).toEqual({ user, isNew: true });
    expect(
      otpVerifyResultSchema.safeParse({ user: { ...user, codeHash: 'x' }, isNew: true }).success,
    ).toBe(false);
    for (const role of ['root', 'platform_admin'])
      expect(
        otpVerifyResultSchema.safeParse({ user: { ...user, role }, isNew: true }).success,
      ).toBe(false);
  });
});
