import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';

const HASH_ALGORITHM = 'sha256';
const HASH_BYTES = 32;
const CODE_DIGITS = 6;
const CODE_SPACE = 10 ** CODE_DIGITS; // codes are 000000..999999

/** Two keys from one OTP_PEPPER: one for code hashes, one for IP hashes and rate-limit keys. */
export type OtpKeys = {
  readonly codeKey: Buffer;
  readonly subjectKey: Buffer;
};

/** Returns a random integer in [0, max). Tests can pass a deterministic one. */
export type PickInt = (max: number) => number;

/** The pepper's length and alphabet are checked once, by env validation at boot. */
export function deriveOtpKeys(pepper: string): OtpKeys {
  return {
    codeKey: deriveKey(pepper, 'code'),
    subjectKey: deriveKey(pepper, 'subject'),
  };
}

/** A 6-digit code, kept as text so leading zeros survive. */
export function makeCode(pick: PickInt = randomInt): string {
  return String(pick(CODE_SPACE)).padStart(CODE_DIGITS, '0');
}

/** The stored form of a code. Tied to the email, so a hash copied to another row matches nothing. */
export function hashCode(keys: OtpKeys, email: string, code: string): string {
  return hmacHex(keys.codeKey, `otp:${email}:${code}`);
}

/** A keyed hash of something that must not be stored raw: an IP address, a rate-limit subject. */
export function hashSubject(keys: OtpKeys, subject: string): string {
  return hmacHex(keys.subjectKey, subject);
}

/** Compares two hex hashes in constant time. Anything that is not a full hash is no match. */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  // Buffer.from stops at the first non-hex character, so a malformed string decodes short
  // and fails this check. It also keeps timingSafeEqual from throwing on unequal lengths.
  if (left.length !== HASH_BYTES || right.length !== HASH_BYTES) return false;
  return timingSafeEqual(left, right);
}

// One secret to manage, and a different label per key, so a hash made with one key can never
// pass for a hash made with the other
function deriveKey(pepper: string, label: string): Buffer {
  const noSalt = '';
  return Buffer.from(hkdfSync(HASH_ALGORITHM, pepper, noSalt, `pulse-otp:${label}`, HASH_BYTES));
}

function hmacHex(key: Buffer, message: string): string {
  return createHmac(HASH_ALGORITHM, key).update(message).digest('hex');
}
