import { emailDelivery, eq, sql, type Database } from '@pulse/db';
import type { NotifyEmailJob } from '@pulse/jobs';
import { randomUUID } from 'node:crypto';
import { PermanentJobError } from '../rabbit/consume.js';
import { smtpFailure } from './smtp.js';
import { renderEmail, type EmailMessage } from './templates.js';

// How long a claim holds before another copy may take it over. Below the 1 min retry tier, so a
// copy that crashed mid-send is picked up by its own retry. A send slower than this (each SMTP
// step has its own timeout, smtp.ts) can be taken over and sent twice; 'sent-unmarked' shows it
const CLAIM_LEASE_SECONDS = 55;

export interface MailerDeps {
  // Connected as pulse_mailer
  db: Database;
  sendMail: (message: EmailMessage) => Promise<void>;
  // Platform ops, until admin users exist: who hears about a new campus
  opsMailTo: string;
}

// sent-unmarked: the email went out but the row could not be marked (the update failed, or a
// slow send lost its claim). The job is still done; the caller logs it, as it may mean a duplicate
export type SendResult = 'sent' | 'sent-unmarked' | 'duplicate';

/**
 * Sends a notify.email job's email once per dedupeKey (ADR 0011). Claim → send → mark: the claim
 * is one statement, so two copies running at once cannot both send. Throws to fail the job (the
 * consumer retries it); a copy that finds the email already sent returns 'duplicate'.
 */
export async function sendEmailJob(deps: MailerDeps, job: NotifyEmailJob): Promise<SendResult> {
  const { db } = deps;
  // Before the claim: a template that cannot render must not hold a claim
  const message = await renderEmail(db, job.payload, deps.opsMailTo);
  const claimId = randomUUID();
  const byKey = eq(emailDelivery.dedupeKey, job.dedupeKey);
  const ours = sql`${emailDelivery.claimId} = ${claimId}`;

  // A new key inserts; an existing row is taken over only after a failed send or an expired
  // claim. No row back: the email is sent, or another copy holds the claim right now
  const claimed = await db
    .insert(emailDelivery)
    .values({
      dedupeKey: job.dedupeKey,
      jobId: job.jobId,
      template: job.payload.template,
      status: 'sending',
      claimId,
    })
    .onConflictDoUpdate({
      target: emailDelivery.dedupeKey,
      set: {
        jobId: job.jobId,
        status: 'sending',
        claimId,
        attempts: sql`${emailDelivery.attempts} + 1`,
        claimedAt: sql`now()`,
        lastError: null,
      },
      setWhere: sql`${emailDelivery.status} = 'failed' or (${emailDelivery.status} = 'sending'
        and ${emailDelivery.claimedAt} < now() - make_interval(secs => ${CLAIM_LEASE_SECONDS}))`,
    })
    .returning({ claimId: emailDelivery.claimId });

  if (claimed.length === 0) {
    const [row] = await db
      .select({ status: emailDelivery.status })
      .from(emailDelivery)
      .where(byKey);
    if (row?.status === 'sent') return 'duplicate';
    // Retried later: by then the other copy has sent it, failed it, or lost its claim
    throw new Error('Another copy of this email job holds the claim');
  }

  try {
    await deps.sendMail(message);
  } catch (error) {
    const failure = smtpFailure(error);
    // If this update fails too, the claim simply runs out; the SMTP failure still decides the retry
    const marked = await db
      .update(emailDelivery)
      .set({ status: 'failed', lastError: failure.label })
      .where(sql`${byKey} and ${ours}`)
      .then(
        () => '',
        () => ' (marking it failed also failed)',
      );
    // The label, not the error: an SMTP reply can quote the recipient's address
    const reason = `${failure.label}${marked}`;
    throw failure.permanent
      ? new PermanentJobError(`Email rejected: ${reason}`)
      : new Error(`Email not sent: ${reason}`);
  }

  // A crash before this line sends the email again once the claim expires: SMTP has no
  // transactions, so this is the one duplicate left (ADR 0011). A failed mark must not fail the
  // job: a retry would send the email again once the claim expires
  const marked = await db
    .update(emailDelivery)
    .set({ status: 'sent', sentAt: sql`now()` })
    .where(sql`${byKey} and ${ours}`)
    .returning({ claimId: emailDelivery.claimId })
    .catch(() => []);
  return marked.length === 1 ? 'sent' : 'sent-unmarked';
}
