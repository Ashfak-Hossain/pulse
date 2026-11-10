import { startTestDatabase } from '@pulse/db/testing';
import { startTestKafka } from '@pulse/events/testing';
import { startTestRabbit } from '@pulse/jobs/testing';
import { GenericContainer, Wait } from 'testcontainers';
import type { TestProject } from 'vitest/node';

// The image Compose runs (infra/compose/compose.yaml)
const mailpitImage = 'axllent/mailpit:v1.33';

// Every service the two programs need, started side by side; the test reads the addresses with
// inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [database, kafka, rabbit, mailpit] = await Promise.all([
    startTestDatabase(),
    startTestKafka(),
    startTestRabbit(),
    new GenericContainer(mailpitImage)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start(),
  ]);
  const mailpitHost = mailpit.getHost();
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('appUrl', database.appUrl);
  project.provide('relayUrl', database.relayUrl);
  project.provide('notifierUrl', database.notifierUrl);
  project.provide('mailerUrl', database.mailerUrl);
  project.provide('kafkaBrokers', kafka.brokers);
  project.provide('amqpUrl', rabbit.amqpUrl);
  project.provide('smtpUrl', `smtp://${mailpitHost}:${mailpit.getMappedPort(1025)}`);
  project.provide('mailpitApi', `http://${mailpitHost}:${mailpit.getMappedPort(8025)}/api/v1`);
  return async () => {
    await Promise.all([database.stop(), kafka.stop(), rabbit.stop(), mailpit.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
    notifierUrl: string;
    mailerUrl: string;
    kafkaBrokers: string[];
    amqpUrl: string;
    smtpUrl: string;
    mailpitApi: string;
  }
}
