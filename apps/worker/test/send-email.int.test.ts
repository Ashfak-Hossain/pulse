import { randomUUID } from 'node:crypto';
import { campus, createDb, emailDelivery, eq, sql } from '@pulse/db';
import { createJob, type NotifyEmailJob } from '@pulse/jobs';
import { inject } from 'vitest';
import { sendEmailJob, type MailerDeps } from '../src/mailer/send-email.js';
import type { EmailMessage } from '../src/mailer/templates.js';
import { PermanentJobError } from '../src/rabbit/consume.js';

const owner = createDb(inject('ownerUrl'));
const mailer = createDb(inject('mailerUrl'));

afterAll(async () => {
  await Promise.all([owner.$client.end(), mailer.$client.end()]);
});

async function newCampus(name = 'Example University'): Promise<string> {
  const id = randomUUID();
  await owner.insert(campus).values({
    id,
    name,
    slug: `campus-${id}`,
    emailDomains: [`${id.slice(0, 8)}.test`],
    location: { x: 90.4, y: 23.8 },
    timezone: 'Asia/Dhaka',
  });
  return id;
}

function emailJob(campusId: string): NotifyEmailJob {
  return createJob(
    'notify.email',
    { template: 'campus-created', campusId },
    { jobId: randomUUID(), dedupeKey: `campus-created:${campusId}`, createdAt: new Date() },
  );
}

function deps(sendMail: MailerDeps['sendMail'] = () => Promise.resolve()): MailerDeps & {
  sent: EmailMessage[];
} {
  const sent: EmailMessage[] = [];
  return {
    db: mailer,
    opsMailTo: 'ops@pulse.test',
    sent,
    sendMail: async (message) => {
      await sendMail(message);
      sent.push(message);
    },
  };
}

async function deliveryOf(job: NotifyEmailJob) {
  const [row] = await owner
    .select()
    .from(emailDelivery)
    .where(eq(emailDelivery.dedupeKey, job.dedupeKey));
  return row;
}

describe('sendEmailJob, as pulse_mailer', () => {
  it('sends the campus-created email to ops and drops a second copy', async () => {
    const job = emailJob(await newCampus('Example University'));
    const mail = deps();

    expect(await sendEmailJob(mail, job)).toBe('sent');
    expect(await sendEmailJob(mail, { ...job, jobId: randomUUID() })).toBe('duplicate');
    expect(mail.sent).toEqual([
      {
        to: 'ops@pulse.test',
        subject: 'New campus on Pulse: Example University',
        text: expect.stringContaining(job.payload.campusId) as string,
      },
    ]);
    expect(await deliveryOf(job)).toMatchObject({ status: 'sent', attempts: 1, jobId: job.jobId });
  });

  // prefetch 10: two copies of one job can run side by side
  it('sends once when two copies run at the same time', async () => {
    const job = emailJob(await newCampus());
    let release: () => void = () => undefined;
    const slowSend = new Promise<void>((resolve) => (release = resolve));
    const mail = deps(() => slowSend);

    const first = sendEmailJob(mail, job);
    await vi.waitFor(async () => expect((await deliveryOf(job))?.status).toBe('sending'));
    await expect(sendEmailJob(mail, job)).rejects.toThrow(/holds the claim/);
    release();
    expect(await first).toBe('sent');
    expect(mail.sent).toHaveLength(1);
  });

  it('records a failed send without the address and lets the retry send it', async () => {
    const job = emailJob(await newCampus());
    const down = Object.assign(new Error('connect ECONNREFUSED ops@pulse.test'), {
      code: 'ECONNECTION',
    });
    await expect(
      sendEmailJob(
        deps(() => Promise.reject(down)),
        job,
      ),
    ).rejects.toThrow('Email not sent: SMTP ECONNECTION');
    expect(await deliveryOf(job)).toMatchObject({
      status: 'failed',
      lastError: 'SMTP ECONNECTION',
    });

    const mail = deps();
    expect(await sendEmailJob(mail, job)).toBe('sent');
    expect(await deliveryOf(job)).toMatchObject({ status: 'sent', attempts: 2, lastError: null });
  });

  it('fails a rejected address for good', async () => {
    const job = emailJob(await newCampus());
    const rejected = Object.assign(new Error('550 <ops@pulse.test> unknown user'), {
      responseCode: 550,
    });
    const sending = sendEmailJob(
      deps(() => Promise.reject(rejected)),
      job,
    );
    await expect(sending).rejects.toThrow(PermanentJobError);
    await expect(sending).rejects.toThrow(/^Email rejected: SMTP 550$/);
  });

  // The worker that held it crashed mid-send: its own retry takes the claim over
  it('takes over a claim whose lease ran out', async () => {
    const job = emailJob(await newCampus());
    await owner.insert(emailDelivery).values({
      dedupeKey: job.dedupeKey,
      jobId: randomUUID(),
      template: 'campus-created',
      status: 'sending',
      claimId: randomUUID(),
      claimedAt: sql`now() - interval '5 minutes'`,
    });
    const mail = deps();
    expect(await sendEmailJob(mail, job)).toBe('sent');
    expect(await deliveryOf(job)).toMatchObject({ status: 'sent', attempts: 2, jobId: job.jobId });
  });

  it('reports, but cannot mark, a row another copy took over during a slow send', async () => {
    const job = emailJob(await newCampus());
    const mail = deps(async () => {
      // While this copy sends, its claim expires and a second copy takes it and fails
      await owner
        .update(emailDelivery)
        .set({ claimId: randomUUID(), status: 'failed', lastError: 'SMTP 421' })
        .where(eq(emailDelivery.dedupeKey, job.dedupeKey));
    });
    expect(await sendEmailJob(mail, job)).toBe('sent-unmarked');
    expect(await deliveryOf(job)).toMatchObject({ status: 'failed', lastError: 'SMTP 421' });
  });

  it('keeps a campus name on one line in the subject', async () => {
    const job = emailJob(await newCampus('Evil\r\nBcc:\u0085\u0007someone@example.test'));
    const mail = deps();
    await sendEmailJob(mail, job);
    expect(mail.sent[0]?.subject).toBe('New campus on Pulse: Evil Bcc: someone@example.test');
  });

  it('fails for good when the campus does not exist, without claiming', async () => {
    const job = emailJob(randomUUID());
    await expect(sendEmailJob(deps(), job)).rejects.toThrow(PermanentJobError);
    expect(await deliveryOf(job)).toBeUndefined();
  });
});
