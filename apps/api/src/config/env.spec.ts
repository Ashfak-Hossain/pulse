import { validateEnv } from './env.js';

const appUrl = 'postgres://pulse_app:fake-test-pw@127.0.0.1:5432/pulse';
const redisUrl = 'redis://127.0.0.1:6379';
const pepper = 'ab'.repeat(32);
const jwtSecret = 'cd'.repeat(32);
// What every boot needs; each test adds or breaks one key
const required = {
  NODE_ENV: 'development',
  DATABASE_URL: appUrl,
  REDIS_URL: redisUrl,
  OTP_PEPPER: pepper,
  JWT_SECRET: jwtSecret,
  APP_ORIGIN: 'http://localhost:5173',
};

describe('validateEnv', () => {
  it('accepts a minimal environment and fills the defaults', () => {
    expect(validateEnv(required)).toEqual({
      ...required,
      HOST: '127.0.0.1',
      PORT: 3000,
    });
  });

  it('turns PORT from a string into a number (env values are always strings)', () => {
    expect(validateEnv({ ...required, PORT: '8080' }).PORT).toBe(8080);
  });

  it('accepts the postgresql:// spelling too', () => {
    const url = 'postgresql://pulse_app:pw@db:5432/pulse';
    expect(validateEnv({ ...required, DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('drops keys it does not know (the real process env has hundreds)', () => {
    expect(validateEnv({ ...required, PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a URL that is not PostgreSQL', () => {
    expect(() => validateEnv({ ...required, DATABASE_URL: 'mysql://u:p@127.0.0.1/pulse' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(['0', '65536', 'abc', '80.5'])('rejects PORT=%s', (port) => {
    expect(() => validateEnv({ ...required, PORT: port })).toThrow(/PORT/);
  });

  it('names every bad key in one error', () => {
    expect(() => validateEnv({ PORT: '0' })).toThrow(
      /PORT[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*PORT/,
    );
  });

  it('accepts an ADMIN_TOKEN made by openssl rand -hex 32', () => {
    const token = '9f'.repeat(32);
    expect(validateEnv({ ...required, ADMIN_TOKEN: token }).ADMIN_TOKEN).toBe(token);
  });

  // The old public placeholder is in the table: a copied example file must stop the boot
  it.each([
    ['too short', 'x'.repeat(42)],
    ['the old public placeholder', 'local-dev-admin-token-not-a-secret-0123'],
    ['a space inside', `${'a'.repeat(43)} b`],
    ['empty', ''],
  ])('rejects an ADMIN_TOKEN that is %s', (_, token) => {
    expect(() => validateEnv({ ...required, ADMIN_TOKEN: token })).toThrow(/ADMIN_TOKEN/);
  });

  // A deploy that forgets NODE_ENV must not boot as development, where codes go to the log
  it.each(['NODE_ENV', 'REDIS_URL', 'OTP_PEPPER', 'JWT_SECRET', 'APP_ORIGIN'])(
    'rejects a missing %s',
    (key) => {
      const env: Record<string, string> = { ...required };
      delete env[key];
      expect(() => validateEnv(env)).toThrow(new RegExp(key));
    },
  );

  it.each(['http://127.0.0.1:6379', 'not a url'])('rejects REDIS_URL=%s', (url) => {
    expect(() => validateEnv({ ...required, REDIS_URL: url })).toThrow(/REDIS_URL/);
  });

  it('accepts rediss:// (Redis over TLS)', () => {
    const url = 'rediss://cache.example:6380';
    expect(validateEnv({ ...required, REDIS_URL: url }).REDIS_URL).toBe(url);
  });

  // The pepper keys every code hash: a short or copied example value must stop the boot
  it.each([
    ['too short', 'x'.repeat(42)],
    ['a space inside', `${'a'.repeat(43)} b`],
    ['empty', ''],
  ])('rejects an OTP_PEPPER that is %s', (_, value) => {
    expect(() => validateEnv({ ...required, OTP_PEPPER: value })).toThrow(/OTP_PEPPER/);
  });

  // The Origin header is exactly scheme://host[:port]; a path or slash would never match it
  it.each(['localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/app', 'not a url'])(
    'rejects APP_ORIGIN=%s',
    (value) => {
      expect(() => validateEnv({ ...required, APP_ORIGIN: value })).toThrow(/APP_ORIGIN/);
    },
  );

  // Anyone who knows the JWT secret can sign in as anyone: same strength rule as the pepper
  it('rejects a JWT_SECRET equal to OTP_PEPPER', () => {
    expect(() => validateEnv({ ...required, JWT_SECRET: pepper })).toThrow(/JWT_SECRET/);
  });

  it('rejects a short JWT_SECRET', () => {
    expect(() => validateEnv({ ...required, JWT_SECRET: 'x'.repeat(42) })).toThrow(/JWT_SECRET/);
  });

  // The only OTP mailer writes codes to the log; production must wait for the email one
  it('refuses NODE_ENV=production while codes only go to the log', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production' })).toThrow(/NODE_ENV/);
  });

  it('never puts the pepper in the error', () => {
    const secret = `${'s'.repeat(43)} leak`;
    let message = '';
    try {
      validateEnv({ ...required, OTP_PEPPER: secret });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/OTP_PEPPER/);
    expect(message).not.toContain('sss');
  });

  it('never puts the URL or its password in the error (startup logs are not secret)', () => {
    const badUrl = 'http://pulse_app:fake-test-pw@127.0.0.1:5432/pulse';
    let message = '';
    try {
      validateEnv({ ...required, DATABASE_URL: badUrl, PORT: 'abc' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('fake-test-pw');
    expect(message).not.toContain('127.0.0.1:5432');
  });
});
