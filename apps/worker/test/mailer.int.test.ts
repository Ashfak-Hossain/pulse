import { randomUUID } from 'node:crypto';
import { campus, createDb, emailDelivery, eq } from '@pulse/db';
import { createJob, jobExchanges, jobQueues, jobTopology, type NotifyEmailJob } from '@pulse/jobs';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { inject } from 'vitest';
import { createMailer } from '../src/mailer/run.js';
import { createSmtpSender, type SmtpSender } from '../src/mailer/smtp.js';
import type { EmailMessage } from '../src/mailer/templates.js';
import type { JobConsumer } from '../src/rabbit/consume.js';
import { ensureTopology } from '../src/rabbit/topology.js';
import { createVhost } from './support/rabbit.js';

// The whole road on real services: RabbitMQ (wait queues shortened to 100 ms), PostgreSQL as
// pulse_mailer, and Mailpit (the image Compose runs) as the mail server
const owner = createDb(inject('ownerUrl'));
const mailerDb = createDb(inject('mailerUrl'), { max: 5 });
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
let mailpit: StartedTestContainer;
let mailpitApi: string;
let smtp: SmtpSender;
let model: ChannelModel;
let publisher: ConfirmChannel;
let consumer: JobConsumer | undefined;

beforeAll(async () => {
  mailpit = await new GenericContainer('axllent/mailpit:v1.33')
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp('/readyz', 8025))
    .start();
  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
  smtp = createSmtpSender(
    `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
    'noreply@pulse.test',
  );
  model = await connect(await createVhost(`mailer-${randomUUID().slice(0, 8)}`));
  await ensureTopology(model, jobTopology({ delayMs: { '10s': 100, '1m': 100, '10m': 100 } }));
  publisher = await model.createConfirmChannel();
}, 120_000);

afterEach(async () => {
  await consumer?.stop();
  consumer = undefined;
});

afterAll(async () => {
  smtp.close();
  await model.close();
  await Promise.all([owner.$client.end(), mailerDb.$client.end()]);
  await mailpit.stop();
});

// Starts the real mailer, sending through Mailpit unless a test passes its own sender
async function startMailer(sendMail: (message: EmailMessage) => Promise<void> = smtp.send) {
  consumer = createMailer({
    deps: { db: mailerDb, sendMail, opsMailTo: 'ops@pulse.test' },
    logger: silent,
    onChannelError: (error) => {
      throw error;
    },
  });
  await consumer.start(model);
}

function failFirst(times: number, failure: object): (message: EmailMessage) => Promise<void> {
  let left = times;
  return (message) => {
    if (left-- > 0) return Promise.reject(Object.assign(new Error('mail server down'), failure));
    return smtp.send(message);
  };
}

async function newCampusJob(): Promise<{ job: NotifyEmailJob; subject: string }> {
  const id = randomUUID();
  const name = `Campus ${id.slice(0, 8)}`;
  await owner.insert(campus).values({
    id,
    name,
    slug: `campus-${id}`,
    emailDomains: [`${id.slice(0, 8)}.test`],
    location: { x: 90.4, y: 23.8 },
    timezone: 'Asia/Dhaka',
  });
  const job = createJob(
    'notify.email',
    { template: 'campus-created', campusId: id },
    { jobId: randomUUID(), dedupeKey: `campus-created:${id}`, createdAt: new Date() },
  );
  return { job, subject: `New campus on Pulse: ${name}` };
}

async function publish(body: unknown): Promise<void> {
  const content = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  publisher.publish(jobExchanges.jobs, 'notify.email', content, { persistent: true });
  await publisher.waitForConfirms();
}

// How many messages Mailpit holds with this exact subject
async function inbox(subject: string): Promise<number> {
  const response = await fetch(`${mailpitApi}/messages?limit=500`);
  const { messages } = (await response.json()) as { messages: { Subject: string }[] };
  return messages.filter((message) => message.Subject === subject).length;
}

async function deadCount(): Promise<number> {
  const channel = await model.createChannel();
  try {
    return (await channel.checkQueue(jobQueues.dead)).messageCount;
  } finally {
    await channel.close();
  }
}

describe('the email worker against RabbitMQ, PostgreSQL and Mailpit', () => {
  it('turns one job into one email, and a second copy into none', async () => {
    await startMailer();
    const { job, subject } = await newCampusJob();
    await publish(job);
    await vi.waitFor(async () => expect(await inbox(subject)).toBe(1), { timeout: 10_000 });

    await publish({ ...job, jobId: randomUUID() });
    await vi.waitFor(async () => {
      const [row] = await owner
        .select({ status: emailDelivery.status })
        .from(emailDelivery)
        .where(eq(emailDelivery.dedupeKey, job.dedupeKey));
      expect(row?.status).toBe('sent');
    });
    // Time for a wrongly sent second email to arrive
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inbox(subject)).toBe(1);
  });

  it('sends once when the same job arrives twice at the same moment', async () => {
    await startMailer();
    const { job, subject } = await newCampusJob();
    await Promise.all([publish(job), publish(job)]);
    await vi.waitFor(async () => expect(await inbox(subject)).toBe(1), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await inbox(subject)).toBe(1);
  });

  // Through jobs.retry, a wait queue and back to q.notify.email, with the failure count growing
  it('retries through the wait queues while the mail server is down, then sends', async () => {
    await startMailer(failFirst(2, { code: 'ECONNECTION' }));
    const { job, subject } = await newCampusJob();
    await publish(job);
    await vi.waitFor(async () => expect(await inbox(subject)).toBe(1), { timeout: 15_000 });
    const [row] = await owner
      .select({ attempts: emailDelivery.attempts })
      .from(emailDelivery)
      .where(eq(emailDelivery.dedupeKey, job.dedupeKey));
    expect(row?.attempts).toBe(3);
  });

  it('gives up after the last wait queue and leaves the job in jobs.dead', async () => {
    const before = await deadCount();
    await startMailer(failFirst(100, { code: 'ECONNECTION' }));
    const { job, subject } = await newCampusJob();
    await publish(job);
    await vi.waitFor(async () => expect(await deadCount()).toBe(before + 1), { timeout: 15_000 });
    expect(await inbox(subject)).toBe(0);
  });

  it('dead-letters a message that is not a job, and keeps reading', async () => {
    await startMailer();
    const before = await deadCount();
    await publish('{not json');
    await vi.waitFor(async () => expect(await deadCount()).toBe(before + 1), { timeout: 10_000 });

    const { job, subject } = await newCampusJob();
    await publish(job);
    await vi.waitFor(async () => expect(await inbox(subject)).toBe(1), { timeout: 10_000 });
  });
});
