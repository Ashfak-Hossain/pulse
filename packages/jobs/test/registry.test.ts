import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createJob, jobTypes, parseJob, type NotifyEmailPayload } from '../src/index.js';

const campusEmail: NotifyEmailPayload = {
  template: 'campus-created',
  campusId: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
};

const meta = {
  jobId: '0b8f3c2e-7d41-4a9b-9e6f-2c5d8a1b3e70',
  dedupeKey: 'campus-created:6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
  createdAt: new Date('2026-11-03T08:30:00.000Z'),
};

describe('createJob', () => {
  it('wraps the payload in an envelope with the current version', () => {
    expect(createJob('notify.email', campusEmail, meta)).toEqual({
      jobId: meta.jobId,
      type: 'notify.email',
      version: 1,
      dedupeKey: meta.dedupeKey,
      createdAt: '2026-11-03T08:30:00.000Z',
      payload: campusEmail,
    });
  });

  // A bad job must fail where it is made, not later in a handler on another machine
  it('throws on an invalid payload', () => {
    expect(() => createJob('notify.email', { ...campusEmail, campusId: 'x' }, meta)).toThrow();
  });

  it('throws on an empty dedupe key', () => {
    expect(() => createJob('notify.email', campusEmail, { ...meta, dedupeKey: '' })).toThrow();
  });
});

describe('parseJob', () => {
  const job = createJob('notify.email', campusEmail, meta);

  it('reads back any valid job that went through JSON', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uuid(),
        fc.stringMatching(/^[a-zA-Z0-9.:_-]{1,200}$/),
        fc.date({ noInvalidDate: true, min: new Date(0), max: new Date('9999-12-31') }),
        (jobId, campusId, dedupeKey, createdAt) => {
          const made = createJob(
            'notify.email',
            { template: 'campus-created', campusId },
            { jobId, dedupeKey, createdAt },
          );
          expect(parseJob(JSON.parse(JSON.stringify(made)))).toEqual({ kind: 'ok', job: made });
        },
      ),
    );
  });

  it('reports a type or version this code does not know as unknown', () => {
    expect(parseJob({ ...job, type: 'notify.push' })).toEqual({
      kind: 'unknown',
      type: 'notify.push',
      version: 1,
    });
    expect(parseJob({ ...job, version: 2 }).kind).toBe('unknown');
  });

  // An unknown type goes into a log line, so it must be a short routing key, nothing else
  it.each(['constructor', '__proto__', 'notify.email\n[FAKE LOG]', `a.${'b'.repeat(100)}`])(
    'rejects the type %j as invalid',
    (type) => {
      expect(parseJob({ ...job, type }).kind).toBe('invalid');
    },
  );

  // A dedupe key sits in jobs.dead and in dedupe rows for a long time: ids only
  it('rejects a dedupe key that is not made of ids', () => {
    expect(parseJob({ ...job, dedupeKey: 'otp:alice@example.com' }).kind).toBe('invalid');
  });

  it('reports a broken envelope or payload as invalid', () => {
    expect(parseJob({ ...job, jobId: 'x' }).kind).toBe('invalid');
    expect(parseJob({ ...job, payload: { template: 'otp', otpId: meta.jobId } }).kind).toBe(
      'invalid',
    );
    expect(parseJob('not a job').kind).toBe('invalid');
  });

  // A newer publisher may add a field; an older worker must still run the job (add-only)
  it('drops payload fields it does not know instead of failing', () => {
    const newer = { ...job, payload: { ...campusEmail, locale: 'bn' } };
    expect(parseJob(newer)).toEqual({ kind: 'ok', job });
  });
});

// The type is the routing key: words joined by '.', no wildcards (* and # mean something in a
// topic binding)
it.each(jobTypes)('%s is a legal routing key', (type) => {
  expect(type).toMatch(/^[a-z]+(\.[a-z]+)+$/);
});
