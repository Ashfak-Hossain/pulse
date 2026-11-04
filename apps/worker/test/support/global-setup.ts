import { startTestDatabase } from '@pulse/db/testing';
import type { TestProject } from 'vitest/node';
import { startTestKafka } from './kafka.js';
import { startTestRabbit } from './rabbit.js';

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
    amqpUrl: string;
    rabbitApiUrl: string;
  }
}
