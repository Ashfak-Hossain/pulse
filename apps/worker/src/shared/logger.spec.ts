import { createLogger } from './logger.js';

// Collects the JSON lines pino writes, instead of stdout
function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write(line: string): void {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  return { lines, destination };
}

describe('createLogger', () => {
  it('writes one JSON object per line, with level, time, name and message', () => {
    const { lines, destination } = capture();
    createLogger({ destination }).info({ count: 3 }, 'Published outbox rows');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      name: 'pulse-worker',
      msg: 'Published outbox rows',
      count: 3,
    });
    expect(typeof lines[0]?.time).toBe('number');
  });

  it('skips levels below the one it was given', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ destination, level: 'warn' });
    logger.info({}, 'hidden');
    logger.warn({}, 'shown');
    expect(lines.map((line) => line.msg)).toEqual(['shown']);
  });

  it.each(['password', 'token', 'authorization', 'cookie', 'url', 'connectionString', 'email'])(
    'hides a %s field, at the top and one level down',
    (field) => {
      const { lines, destination } = capture();
      createLogger({ destination }).info(
        { [field]: 'secret-value', nested: { [field]: 'secret-value' } },
        'message',
      );
      const text = JSON.stringify(lines);
      expect(text).not.toContain('secret-value');
      expect(lines[0]).toMatchObject({ [field]: '[Redacted]', nested: { [field]: '[Redacted]' } });
    },
  );
});
