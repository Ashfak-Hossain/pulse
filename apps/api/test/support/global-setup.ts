import { startTestDatabase } from '@pulse/db/testing';
import type { TestProject } from 'vitest/node';

// One PostGIS container for the whole e2e run; each test file reads the URLs with inject()
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await startTestDatabase();
  project.provide('ownerUrl', database.ownerUrl);
  project.provide('appUrl', database.appUrl);
  return database.stop;
}

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}
