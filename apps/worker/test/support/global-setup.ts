import type { TestProject } from 'vitest/node';
import { startTestKafka } from './kafka.js';

// One Kafka container for the whole run; each test file reads the brokers with inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const kafka = await startTestKafka();
  project.provide('kafkaBrokers', kafka.brokers);
  return kafka.stop;
}

declare module 'vitest' {
  export interface ProvidedContext {
    kafkaBrokers: string[];
  }
}
