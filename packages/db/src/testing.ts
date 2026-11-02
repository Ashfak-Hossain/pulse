import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

const initFolder = new URL('../../../infra/compose/postgres/init/', import.meta.url);
const roleScripts = ['01-app-role.sql', '02-relay-role.sql'];
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

export type TestDatabase = {
  // The owner (pulse): bypasses row-level security, for setting up test rows
  ownerUrl: string;
  // The app role (pulse_app): what the API and worker connect as
  appUrl: string;
  // The relay role (pulse_relay): reads and marks outbox_event, nothing else
  relayUrl: string;
  stop: () => Promise<void>;
};

// Tests only (`@pulse/db/testing`; the apps never import it): a throwaway PostGIS with our roles
// and every migration applied. Start one per test run: PostGIS under Rosetta takes ~20 s
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgis/postgis:18-3.6')
    .withPlatform('linux/amd64')
    .withUsername('pulse')
    // Random: the owner bypasses row-level security, and Docker may publish the port on the LAN
    .withPassword(randomUUID())
    .withDatabase('pulse')
    // The same scripts Compose runs, so tests and local dev have the same roles
    .withCopyFilesToContainer(
      roleScripts.map((name) => ({
        source: fileURLToPath(new URL(name, initFolder)),
        target: `/docker-entrypoint-initdb.d/${name}`,
      })),
    )
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

  return {
    ownerUrl,
    appUrl: urlAs(ownerUrl, 'pulse_app'),
    relayUrl: urlAs(ownerUrl, 'pulse_relay'),
    stop: async () => {
      await container.stop();
    },
  };
}

// The init scripts set each role's password to its name (throwaway local defaults)
function urlAs(ownerUrl: string, role: string): string {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = role;
  return url.href;
}
