import { DrizzleQueryError } from '@pulse/db';
import { describeError } from './errors.js';

describe('describeError', () => {
  it('gives the name and message of an Error', () => {
    expect(describeError(new TypeError('bad value'))).toBe('TypeError: bad value');
  });

  it('adds a string code when there is one', () => {
    const error = Object.assign(new Error('broker down'), { code: 'PLT_KFK_NETWORK' });
    expect(describeError(error)).toBe('Error [PLT_KFK_NETWORK]: broker down');
  });

  it('turns a thrown value that is not an Error into a string', () => {
    expect(describeError('plain string')).toBe('plain string');
  });

  it('never includes the cause (a ZodError there can hold row data)', () => {
    const error = new Error('row is not a valid event', {
      cause: new Error('payload.email=a@example.test'),
    });
    expect(describeError(error)).not.toContain('a@example.test');
  });

  // Drizzle's own message is "Failed query: <sql> params: <values>", and the values can be row data
  it('describes a failed query by its database error, never by the query or its params', () => {
    const pgError = Object.assign(new Error('permission denied for table outbox_event'), {
      code: '42501',
    });
    const error = new DrizzleQueryError(
      'select * from x where email = $1',
      ['a@example.test'],
      pgError,
    );

    const text = describeError(error);

    expect(text).toContain('42501');
    expect(text).toContain('permission denied for table outbox_event');
    expect(text).not.toContain('a@example.test');
    expect(text).not.toContain('select');
  });

  it('still says something for a failed query without a cause', () => {
    const error = new DrizzleQueryError('select $1', ['a@example.test']);
    const text = describeError(error);
    expect(text).toMatch(/query failed/i);
    expect(text).not.toContain('a@example.test');
  });
});
