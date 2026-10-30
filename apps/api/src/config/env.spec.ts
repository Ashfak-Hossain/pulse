import { validateEnv } from './env.js';

const appUrl = 'postgres://pulse_app:fake-test-pw@127.0.0.1:5432/pulse';

describe('validateEnv', () => {
  it('accepts a minimal environment and fills the defaults', () => {
    expect(validateEnv({ DATABASE_URL: appUrl })).toEqual({
      DATABASE_URL: appUrl,
      HOST: '127.0.0.1',
      PORT: 3000,
    });
  });

  it('turns PORT from a string into a number (env values are always strings)', () => {
    expect(validateEnv({ DATABASE_URL: appUrl, PORT: '8080' }).PORT).toBe(8080);
  });

  it('accepts the postgresql:// spelling too', () => {
    const url = 'postgresql://pulse_app:pw@db:5432/pulse';
    expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('drops keys it does not know (the real process env has hundreds)', () => {
    expect(validateEnv({ DATABASE_URL: appUrl, PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a URL that is not PostgreSQL', () => {
    expect(() => validateEnv({ DATABASE_URL: 'mysql://u:p@127.0.0.1/pulse' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it.each(['0', '65536', 'abc', '80.5'])('rejects PORT=%s', (port) => {
    expect(() => validateEnv({ DATABASE_URL: appUrl, PORT: port })).toThrow(/PORT/);
  });

  it('names every bad key in one error', () => {
    expect(() => validateEnv({ PORT: '0' })).toThrow(
      /PORT[\s\S]*DATABASE_URL|DATABASE_URL[\s\S]*PORT/,
    );
  });

  it('never puts the URL or its password in the error (startup logs are not secret)', () => {
    const badUrl = 'http://pulse_app:fake-test-pw@127.0.0.1:5432/pulse';
    let message = '';
    try {
      validateEnv({ DATABASE_URL: badUrl, PORT: 'abc' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('fake-test-pw');
    expect(message).not.toContain('127.0.0.1:5432');
  });
});
