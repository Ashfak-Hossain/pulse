import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { TestProject } from 'vitest/node';

const appRoleScript = fileURLToPath(
  new URL('../../../../infra/compose/postgres/init/01-app-role.sql', import.meta.url),
);
const migrationsFolder = fileURLToPath(new URL('../../migrations', import.meta.url));

// One container for the whole run: PostGIS under Rosetta takes ~20 s to start
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer('postgis/postgis:18-3.6')
    .withPlatform('linux/amd64')
    .withUsername('pulse')
    .withPassword('pulse')
    .withDatabase('pulse')
    // The same script Compose runs, so tests and local dev have the same roles
    .withCopyFilesToContainer([
      { source: appRoleScript, target: '/docker-entrypoint-initdb.d/01-app-role.sql' },
    ])
    // Compose's init mount hides the image's own script, which pre-installs PostGIS extras.
    // Hide it here too, so migration 0000 is the only thing that installs PostGIS, everywhere
    .withCopyContentToContainer([
      { content: '', target: '/docker-entrypoint-initdb.d/10_postgis.sh' },
    ])
    .start();

  const ownerUrl = container.getConnectionUri();
  const owner = drizzle(ownerUrl);
  let failure: unknown;
  try {
    await migrate(owner, { migrationsFolder });
  } catch (error) {
    failure = error;
  } finally {
    // Close the pool before the container goes, or its idle connection errors on the way out
    await owner.$client.end();
  }
  if (failure !== undefined) {
    // Vitest 5 crashes while printing an error thrown from global setup, so print it first
    console.error('Database setup failed:', failure);
    await container.stop();
    throw new Error('Database setup failed', { cause: failure });
  }

  const appUrl = new URL(ownerUrl);
  appUrl.username = 'pulse_app';
  appUrl.password = 'pulse_app';

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', appUrl.href);

  return async () => {
    await container.stop();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}
