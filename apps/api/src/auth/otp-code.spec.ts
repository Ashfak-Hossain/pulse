import { deriveOtpKeys, hashCode, hashSubject, makeCode, sameHash } from './otp-code.js';

const keys = deriveOtpKeys('ab'.repeat(32));
const email = 'student@aiub.edu';

describe('makeCode', () => {
  it('always gives six digits', () => {
    for (let i = 0; i < 500; i++) expect(makeCode()).toMatch(/^\d{6}$/);
  });

  // A number would turn 000042 into 42, and the user would type a code we never stored
  it.each([
    [0, '000000'],
    [42, '000042'],
    [999_999, '999999'],
  ])('pads %i to %s', (picked, code) => {
    expect(makeCode(() => picked)).toBe(code);
  });

  it('asks the picker for a number below one million', () => {
    const asked: number[] = [];
    makeCode((max) => {
      asked.push(max);
      return 0;
    });
    expect(asked).toEqual([1_000_000]);
  });
});

describe('deriveOtpKeys', () => {
  it('gives two different 32-byte keys from one pepper', () => {
    expect(keys.codeKey).toHaveLength(32);
    expect(keys.subjectKey).toHaveLength(32);
    expect(keys.codeKey.equals(keys.subjectKey)).toBe(false);
  });
});

describe('hashCode', () => {
  const hash = hashCode(keys, email, '004217');

  it('is 64 hex characters, the shape the email_otp CHECK accepts', () => {
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is the same for the same email and code', () => {
    expect(hashCode(keys, email, '004217')).toBe(hash);
  });

  // Tied to the email: a hash copied to another row (or a stolen table) is not a code for anyone
  it.each([
    ['another code', keys, email, '004218'],
    ['another email', keys, 'other@aiub.edu', '004217'],
    ['another pepper', deriveOtpKeys('cd'.repeat(32)), email, '004217'],
  ])('changes with %s', (_, otherKeys, otherEmail, code) => {
    expect(hashCode(otherKeys, otherEmail, code)).not.toBe(hash);
  });

  it('never contains the code', () => {
    expect(hash).not.toContain('004217');
  });
});

describe('hashSubject', () => {
  it('is 64 hex characters and stable', () => {
    expect(hashSubject(keys, 'ip:127.0.0.1')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSubject(keys, 'ip:127.0.0.1')).toBe(hashSubject(keys, 'ip:127.0.0.1'));
  });

  // Separate keys: an index hash can never be offered as a code hash
  it('differs from a code hash of the same text', () => {
    expect(hashSubject(keys, `otp:${email}:004217`)).not.toBe(hashCode(keys, email, '004217'));
  });
});

describe('sameHash', () => {
  const hash = hashCode(keys, email, '123456');

  it('accepts the same hash', () => {
    expect(sameHash(hash, hashCode(keys, email, '123456'))).toBe(true);
  });

  it('rejects a near miss', () => {
    const last = hash.at(-1) === '0' ? '1' : '0';
    expect(sameHash(hash, `${hash.slice(0, -1)}${last}`)).toBe(false);
  });

  // timingSafeEqual throws on different lengths; a bad stored value must be a plain "no"
  it.each(['', 'abc', `${hash}00`])('rejects %o without throwing', (other) => {
    expect(sameHash(hash, other)).toBe(false);
  });
});
