import type { TestProject } from 'vitest/node';
import { startTestDatabase } from '../../src/testing.js';

// One container for the whole run; each test file reads the URLs with inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('appUrl', database.appUrl);
  project.provide('relayUrl', database.relayUrl);
  return database.stop;
}

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
  }
}
