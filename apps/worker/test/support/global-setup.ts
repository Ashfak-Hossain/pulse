import { startTestDatabase } from '@pulse/db/testing';
import type { TestProject } from 'vitest/node';
import { startTestKafka } from './kafka.js';

// One Kafka and one PostGIS for the whole run, started side by side; each test file reads the
// addresses with inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [kafka, database] = await Promise.all([startTestKafka(), startTestDatabase()]);
  project.provide('kafkaBrokers', kafka.brokers);
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('relayUrl', database.relayUrl);
  return async () => {
    await Promise.all([kafka.stop(), database.stop()]);
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    kafkaBrokers: string[];
    ownerUrl: string;
    relayUrl: string;
  }
}
