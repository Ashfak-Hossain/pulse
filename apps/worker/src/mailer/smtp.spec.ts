import { smtpFailure, transportOptions } from './smtp.js';

describe('smtpFailure', () => {
  it.each([
    [{ responseCode: 550, response: '550 <ada@example.test> rejected' }, 'SMTP 550', true],
    [{ responseCode: 421 }, 'SMTP 421', false],
    // A wrong login is fixed in config; the job should still be waiting when it is
    [{ responseCode: 535, code: 'EAUTH' }, 'SMTP 535', false],
    [
      { code: 'ECONNECTION', message: 'connect ECONNREFUSED 127.0.0.1:1025' },
      'SMTP ECONNECTION',
      false,
    ],
    [{ code: 'ETIMEDOUT' }, 'SMTP ETIMEDOUT', false],
    [{ code: 'ada@example.test' }, 'SMTP send failed', false],
    [new Error('boom'), 'SMTP send failed', false],
    ['text', 'SMTP send failed', false],
  ])('labels %o as %s (permanent: %s)', (error, label, permanent) => {
    expect(smtpFailure(error)).toEqual({ label, permanent });
  });
});

describe('transportOptions', () => {
  // Without requireTLS, nodemailer sends the login in clear text if the STARTTLS offer is stripped
  it.each([
    ['smtp://pulse:secret@smtp.example.com:587', true],
    ['smtp://smtp.example.com:25', false],
    ['smtps://pulse:secret@smtp.example.com:465', false],
    ['smtp://pulse:secret@127.0.0.1:1025', false],
    ['smtp://pulse:secret@localhost:1025', false],
    ['smtp://127.0.0.1:1025', false],
  ])('%s → requireTLS %s', (url, requireTLS) => {
    expect(transportOptions(url)).toEqual({
      url,
      requireTLS,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    });
  });
});
