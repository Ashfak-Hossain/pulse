import { validateEnv } from './env.js';

const relayUrl = 'postgres://pulse_relay:pulse_relay@127.0.0.1:5432/pulse';
const amqpUrl = 'amqp://pulse:pulse@127.0.0.1:5672';
const notifierUrl = 'postgres://pulse_notifier:pulse_notifier@127.0.0.1:5432/pulse';
const mailerUrl = 'postgres://pulse_mailer:pulse_mailer@127.0.0.1:5432/pulse';
const smtpUrl = 'smtp://127.0.0.1:1025';
// The keys without a default
const required = {
  RELAY_DATABASE_URL: relayUrl,
  AMQP_URL: amqpUrl,
  NOTIFIER_DATABASE_URL: notifierUrl,
  MAILER_DATABASE_URL: mailerUrl,
  SMTP_URL: smtpUrl,
  MAIL_FROM: 'noreply@pulse.test',
  OPS_MAIL_TO: 'ops@pulse.test',
};

describe('validateEnv', () => {
  it('fills the defaults for local dev (Compose Kafka on the HOST listener)', () => {
    expect(validateEnv(required)).toEqual({
      KAFKA_BROKERS: ['127.0.0.1:9092'],
      KAFKA_CLIENT_ID: 'pulse-worker',
      KAFKA_REPLICATION_FACTOR: 1,
      KAFKA_MIN_INSYNC_REPLICAS: 1,
      RELAY_DATABASE_URL: relayUrl,
      RELAY_BATCH_SIZE: 100,
      RELAY_POLL_MS: 500,
      AMQP_URL: amqpUrl,
      NOTIFIER_DATABASE_URL: notifierUrl,
      MAILER_DATABASE_URL: mailerUrl,
      SMTP_URL: smtpUrl,
      MAIL_FROM: 'noreply@pulse.test',
      OPS_MAIL_TO: 'ops@pulse.test',
    });
  });

  it('splits a comma-separated broker list and trims spaces', () => {
    expect(
      validateEnv({ ...required, KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092' }).KAFKA_BROKERS,
    ).toEqual(['kafka-1:9092', 'kafka-2:9092']);
  });

  it.each(['', 'kafka', 'kafka:', ':9092', 'kafka:abc', 'kafka:0', 'kafka:65536', 'a:1,,b:2'])(
    'rejects KAFKA_BROKERS=%j',
    (brokers) => {
      expect(() => validateEnv({ ...required, KAFKA_BROKERS: brokers })).toThrow(/KAFKA_BROKERS/);
    },
  );

  it('turns the replica settings from strings into numbers (env values are always strings)', () => {
    const env = validateEnv({
      ...required,
      KAFKA_REPLICATION_FACTOR: '3',
      KAFKA_MIN_INSYNC_REPLICAS: '2',
    });
    expect(env.KAFKA_REPLICATION_FACTOR).toBe(3);
    expect(env.KAFKA_MIN_INSYNC_REPLICAS).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects KAFKA_REPLICATION_FACTOR=%s', (value) => {
    expect(() => validateEnv({ ...required, KAFKA_REPLICATION_FACTOR: value })).toThrow(
      /KAFKA_REPLICATION_FACTOR/,
    );
  });

  // More in-sync replicas than copies would make every acks=all write fail
  it('rejects KAFKA_MIN_INSYNC_REPLICAS above KAFKA_REPLICATION_FACTOR', () => {
    expect(() =>
      validateEnv({ ...required, KAFKA_REPLICATION_FACTOR: '1', KAFKA_MIN_INSYNC_REPLICAS: '2' }),
    ).toThrow(/KAFKA_MIN_INSYNC_REPLICAS/);
  });

  it('requires RELAY_DATABASE_URL (no guessed database address)', () => {
    expect(() => validateEnv({})).toThrow(/RELAY_DATABASE_URL/);
  });

  it.each(['postgresql://pulse_relay:pw@db:5432/pulse', relayUrl])(
    'accepts RELAY_DATABASE_URL=%s',
    (url) => {
      expect(validateEnv({ ...required, RELAY_DATABASE_URL: url }).RELAY_DATABASE_URL).toBe(url);
    },
  );

  it.each(['', 'not a url', 'mysql://u:p@db/pulse', 'http://db:5432/pulse'])(
    'rejects RELAY_DATABASE_URL=%j',
    (url) => {
      expect(() => validateEnv({ ...required, RELAY_DATABASE_URL: url })).toThrow(
        /RELAY_DATABASE_URL/,
      );
    },
  );

  it('requires AMQP_URL (no guessed broker address)', () => {
    expect(() => validateEnv({ ...required, AMQP_URL: undefined })).toThrow(/AMQP_URL/);
  });

  // Its own role, so a bug in the notifier cannot touch the outbox (and the relay cannot touch
  // processed_event)
  it('requires NOTIFIER_DATABASE_URL, a postgres URL', () => {
    expect(() => validateEnv({ ...required, NOTIFIER_DATABASE_URL: undefined })).toThrow(
      /NOTIFIER_DATABASE_URL/,
    );
    expect(() =>
      validateEnv({ ...required, NOTIFIER_DATABASE_URL: 'http://db:5432/pulse' }),
    ).toThrow(/NOTIFIER_DATABASE_URL/);
  });

  // No defaults: SMTP_URL can hold a password, and a guessed address could mail real people
  it.each(['MAILER_DATABASE_URL', 'SMTP_URL', 'MAIL_FROM', 'OPS_MAIL_TO'])('requires %s', (key) => {
    expect(() => validateEnv({ ...required, [key]: undefined })).toThrow(new RegExp(key));
  });

  it.each([
    ['MAILER_DATABASE_URL', 'http://db:5432/pulse'],
    ['SMTP_URL', 'http://127.0.0.1:1025'],
    ['SMTP_URL', '127.0.0.1:1025'],
    ['MAIL_FROM', 'Pulse'],
    ['OPS_MAIL_TO', 'ops@'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => validateEnv({ ...required, [key]: value })).toThrow(new RegExp(key));
  });

  it('accepts SMTP over TLS with a login', () => {
    const url = 'smtps://pulse:secret@smtp.example.com:465';
    expect(validateEnv({ ...required, SMTP_URL: url }).SMTP_URL).toBe(url);
  });

  it.each(['amqps://pulse:pw@rabbit.example.com:5671/pulse', amqpUrl])(
    'accepts AMQP_URL=%s',
    (url) => {
      expect(validateEnv({ ...required, AMQP_URL: url }).AMQP_URL).toBe(url);
    },
  );

  it.each(['', 'rabbitmq:5672', 'http://pulse:pulse@rabbitmq:5672'])(
    'rejects AMQP_URL=%j',
    (url) => {
      expect(() => validateEnv({ ...required, AMQP_URL: url })).toThrow(/AMQP_URL/);
    },
  );

  it('turns the relay numbers from strings into numbers', () => {
    const env = validateEnv({ ...required, RELAY_BATCH_SIZE: '250', RELAY_POLL_MS: '2000' });
    expect(env.RELAY_BATCH_SIZE).toBe(250);
    expect(env.RELAY_POLL_MS).toBe(2000);
  });

  it.each(['1', '1000'])('accepts RELAY_BATCH_SIZE=%s (the edges)', (value) => {
    expect(validateEnv({ ...required, RELAY_BATCH_SIZE: value }).RELAY_BATCH_SIZE).toBe(
      Number(value),
    );
  });

  it.each(['0', '-1', '1.5', 'abc', '1001'])('rejects RELAY_BATCH_SIZE=%s', (value) => {
    expect(() => validateEnv({ ...required, RELAY_BATCH_SIZE: value })).toThrow(/RELAY_BATCH_SIZE/);
  });

  it.each(['50', '60000'])('accepts RELAY_POLL_MS=%s (the edges)', (value) => {
    expect(validateEnv({ ...required, RELAY_POLL_MS: value }).RELAY_POLL_MS).toBe(Number(value));
  });

  it.each(['49', '0', '-1', '1.5', 'abc', '60001'])('rejects RELAY_POLL_MS=%s', (value) => {
    expect(() => validateEnv({ ...required, RELAY_POLL_MS: value })).toThrow(/RELAY_POLL_MS/);
  });

  it('drops keys it does not know (the real process env has hundreds)', () => {
    expect(validateEnv({ ...required, PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('names every bad key in one error', () => {
    expect(() => validateEnv({ KAFKA_BROKERS: 'nope', KAFKA_REPLICATION_FACTOR: '0' })).toThrow(
      /KAFKA_BROKERS[\s\S]*KAFKA_REPLICATION_FACTOR|KAFKA_REPLICATION_FACTOR[\s\S]*KAFKA_BROKERS/,
    );
  });

  it.each([
    ['KAFKA_BROKERS', 'secret-host-name'],
    ['RELAY_DATABASE_URL', 'mysql://pulse_relay:secret-password@db/pulse'],
    ['AMQP_URL', 'http://pulse:secret-password@rabbitmq:5672'],
    ['NOTIFIER_DATABASE_URL', 'mysql://pulse_notifier:secret-password@db/pulse'],
  ])('never puts a value in the error (startup logs are not secret): %s', (key, value) => {
    let message = '';
    try {
      validateEnv({ ...required, [key]: value });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(new RegExp(key));
    expect(message).not.toContain('secret');
  });
});
