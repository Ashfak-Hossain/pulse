import { z } from 'zod';
import { jobEnvelopeSchema } from './envelope.js';
import { notifyEmailJobSchema } from './notify-email.js';

// A new job type = its schema file, plus one entry here and one in jobSpecs
export const jobSchema = z.discriminatedUnion('type', [notifyEmailJobSchema]);

export type PulseJob = z.infer<typeof jobSchema>;
export type JobType = PulseJob['type'];
type JobOf<T extends JobType> = Extract<PulseJob, { type: T }>;

export interface JobSpec {
  // The version createJob writes today
  readonly version: number;
  // How many unacked jobs one handler holds at a time
  readonly prefetch: number;
}

export const jobSpecs = {
  'notify.email': { version: 1, prefetch: 10 },
} as const satisfies Record<JobType, JobSpec>;

export const jobTypes = Object.keys(jobSpecs) as JobType[];

export interface JobMeta {
  jobId: string;
  dedupeKey: string;
  createdAt: Date;
}

export function createJob<T extends JobType>(
  type: T,
  payload: JobOf<T>['payload'],
  meta: JobMeta,
): JobOf<T> {
  const job = {
    jobId: meta.jobId,
    type,
    version: jobSpecs[type].version,
    dedupeKey: meta.dedupeKey,
    createdAt: meta.createdAt.toISOString(),
    payload,
  };

  return jobSchema.parse(job) as JobOf<T>;
}

// What a handler should do with a message: run it, or dead-letter it (unknown means it reached
// the wrong queue or a newer publisher sent it)
export type ParsedJob =
  | { kind: 'ok'; job: PulseJob }
  | { kind: 'unknown'; type: string; version: number }
  | { kind: 'invalid'; error: z.ZodError };

// For handlers: never throws. Zod's issues hold paths and codes, not input values, so logging
// error.issues does not leak the payload
export function parseJob(raw: unknown): ParsedJob {
  const envelope = jobEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { kind: 'invalid', error: envelope.error };

  const { type, version } = envelope.data;
  if (!isKnown(type, version)) return { kind: 'unknown', type, version };

  const job = jobSchema.safeParse(raw);
  return job.success ? { kind: 'ok', job: job.data } : { kind: 'invalid', error: job.error };
}

// Object.hasOwn, not `in`: a type such as "constructor" must not match Object.prototype
function isKnown(type: string, version: number): boolean {
  return Object.hasOwn(jobSpecs, type) && jobSpecs[type as JobType].version === version;
}
