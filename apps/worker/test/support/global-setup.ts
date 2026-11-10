import { startTestDatabase } from '@pulse/db/testing';
import { startTestKafka } from '@pulse/events/testing';
import { startTestRabbit } from '@pulse/jobs/testing';
import type { TestProject } from 'vitest/node';

// One Kafka, one PostGIS and one RabbitMQ for the whole run, started side by side; each test
// file reads the addresses with inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [kafka, database, rabbit] = await Promise.all([
    startTestKafka(),
    startTestDatabase(),
    startTestRabbit(),
  ]);
  project.provide('kafkaBrokers', kafka.brokers);
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('relayUrl', database.relayUrl);
  project.provide('notifierUrl', database.notifierUrl);
  project.provide('mailerUrl', database.mailerUrl);
  project.provide('amqpUrl', rabbit.amqpUrl);
  project.provide('rabbitApiUrl', rabbit.apiUrl);
  return async () => {
    await Promise.all([kafka.stop(), database.stop(), rabbit.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    kafkaBrokers: string[];
    ownerUrl: string;
    relayUrl: string;
    notifierUrl: string;
    mailerUrl: string;
    amqpUrl: string;
    rabbitApiUrl: string;
  }
}
