import type { Database } from '@pulse/db';
import { jobSpecs, queueFor } from '@pulse/jobs';
import { JobConsumer, PermanentJobError } from '../rabbit/consume.js';
import { createWorkerDb } from '../shared/db.js';
import type { BasicLogger } from '../shared/logger.js';
import { sendEmailJob, type MailerDeps } from './send-email.js';

// Every query is short and none runs inside a long transaction. Room for the queue's prefetch
// of 10 to share connections without waiting long
const DB_LIMITS = {
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10_000,
  query_timeout: 15_000,
  keepAlive: true,
};

/** The mailer's pool, connected as pulse_mailer. */
export function createMailerDb(url: string, logger: Pick<BasicLogger, 'warn'>): Database {
  return createWorkerDb(url, logger, DB_LIMITS);
}

export interface MailerOptions {
  deps: MailerDeps;
  logger: BasicLogger;
  onChannelError: (error: Error) => void;
}

/**
 * The consumer of q.notify.email. The RabbitMQ setup starts it on every connect; stop it before
 * the connection and the pool close, so emails being sent can finish.
 */
export function createMailer({ deps, logger, onChannelError }: MailerOptions): JobConsumer {
  return new JobConsumer({
    queue: queueFor('notify.email'),
    prefetch: jobSpecs['notify.email'].prefetch,
    logger,
    onChannelError,
    handle: async (job) => {
      // Only a job moved here by hand can be another type
      if (job.type !== 'notify.email') throw new PermanentJobError('Not a notify.email job');
      const result = await sendEmailJob(deps, job);
      const fields = { jobId: job.jobId, template: job.payload.template, result };
      if (result === 'sent-unmarked') {
        logger.warn(
          fields,
          'Email sent but not marked: a slow send or a database error, may repeat',
        );
      } else {
        logger.info(
          fields,
          result === 'sent' ? 'Email sent' : 'Email was already sent, dropped this copy',
        );
      }
    },
  });
}
