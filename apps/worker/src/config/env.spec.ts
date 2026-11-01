import { validateEnv } from './env.js';

describe('validateEnv', () => {
  it('fills the defaults for local dev (Compose Kafka on the HOST listener)', () => {
    expect(validateEnv({})).toEqual({
      KAFKA_BROKERS: ['127.0.0.1:9092'],
      KAFKA_CLIENT_ID: 'pulse-worker',
      KAFKA_REPLICATION_FACTOR: 1,
      KAFKA_MIN_INSYNC_REPLICAS: 1,
    });
  });

  it('splits a comma-separated broker list and trims spaces', () => {
    expect(validateEnv({ KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092' }).KAFKA_BROKERS).toEqual([
      'kafka-1:9092',
      'kafka-2:9092',
    ]);
  });

  it.each(['', 'kafka', 'kafka:', ':9092', 'kafka:abc', 'kafka:0', 'kafka:65536', 'a:1,,b:2'])(
    'rejects KAFKA_BROKERS=%j',
    (brokers) => {
      expect(() => validateEnv({ KAFKA_BROKERS: brokers })).toThrow(/KAFKA_BROKERS/);
    },
  );

  it('turns the replica settings from strings into numbers (env values are always strings)', () => {
    const env = validateEnv({ KAFKA_REPLICATION_FACTOR: '3', KAFKA_MIN_INSYNC_REPLICAS: '2' });
    expect(env.KAFKA_REPLICATION_FACTOR).toBe(3);
    expect(env.KAFKA_MIN_INSYNC_REPLICAS).toBe(2);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects KAFKA_REPLICATION_FACTOR=%s', (value) => {
    expect(() => validateEnv({ KAFKA_REPLICATION_FACTOR: value })).toThrow(
      /KAFKA_REPLICATION_FACTOR/,
    );
  });

  // More in-sync replicas than copies would make every acks=all write fail
  it('rejects KAFKA_MIN_INSYNC_REPLICAS above KAFKA_REPLICATION_FACTOR', () => {
    expect(() =>
      validateEnv({ KAFKA_REPLICATION_FACTOR: '1', KAFKA_MIN_INSYNC_REPLICAS: '2' }),
    ).toThrow(/KAFKA_MIN_INSYNC_REPLICAS/);
  });

  it('drops keys it does not know (the real process env has hundreds)', () => {
    expect(validateEnv({ PATH: '/usr/bin' })).not.toHaveProperty('PATH');
  });

  it('names every bad key in one error', () => {
    expect(() => validateEnv({ KAFKA_BROKERS: 'nope', KAFKA_REPLICATION_FACTOR: '0' })).toThrow(
      /KAFKA_BROKERS[\s\S]*KAFKA_REPLICATION_FACTOR|KAFKA_REPLICATION_FACTOR[\s\S]*KAFKA_BROKERS/,
    );
  });

  it('never puts a value in the error (startup logs are not secret)', () => {
    let message = '';
    try {
      validateEnv({ KAFKA_BROKERS: 'secret-host-name' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/KAFKA_BROKERS/);
    expect(message).not.toContain('secret-host-name');
  });
});
