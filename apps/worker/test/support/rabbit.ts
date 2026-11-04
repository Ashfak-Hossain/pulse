import { inject, vi } from 'vitest';
import { GenericContainer, Wait } from 'testcontainers';

export type TestRabbit = {
  amqpUrl: string;
  // The management HTTP API, for what AMQP cannot do: read queue arguments, drop connections
  apiUrl: string;
  stop: () => Promise<void>;
};

// The image Compose runs (infra/compose/compose.yaml), so tests prove what we run
const image = 'rabbitmq:4.4-management-alpine';
const user = 'pulse';
const password = 'pulse';

export async function startTestRabbit(): Promise<TestRabbit> {
  const container = await new GenericContainer(image)
    .withExposedPorts(5672, 15672)
    .withEnvironment({ RABBITMQ_DEFAULT_USER: user, RABBITMQ_DEFAULT_PASS: password })
    // Logged once the management plugin is up too
    .withWaitStrategy(Wait.forLogMessage(/Server startup complete/))
    .start();

  const host = container.getHost();
  return {
    amqpUrl: `amqp://${user}:${password}@${host}:${container.getMappedPort(5672)}`,
    apiUrl: `http://${host}:${container.getMappedPort(15672)}/api`,
    stop: async () => {
      await container.stop();
    },
  };
}

/** Calls the management API of the test broker (default vhost is %2F in paths). */
export async function rabbitApi(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const response = await fetch(`${inject('rabbitApiUrl')}${path}`, {
    method,
    headers: {
      authorization: `Basic ${btoa(`${user}:${password}`)}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return response;
}

/**
 * A vhost of its own for one test file: the job topology uses fixed queue names, so files that
 * run side by side each get a separate copy of every queue. Returns its AMQP URL.
 */
export async function createVhost(name: string): Promise<string> {
  await rabbitApi(`/vhosts/${name}`, 'PUT');
  await rabbitApi(`/permissions/${name}/${user}`, 'PUT', {
    configure: '.*',
    write: '.*',
    read: '.*',
  });
  return `${inject('amqpUrl')}/${name}`;
}

/**
 * Drops every client connection to one vhost, as a broker restart or a network cut would. The
 * API lists a new connection only after its next stats update (~5 s), so wait until `count` are
 * listed.
 */
export async function dropAllConnections(count: number, vhost = '/'): Promise<void> {
  const connections = await vi.waitFor(
    async () => {
      const listed = (await (await rabbitApi('/connections')).json()) as {
        name: string;
        vhost: string;
      }[];
      const inVhost = listed.filter((connection) => connection.vhost === vhost);
      if (inVhost.length < count) {
        throw new Error(`${inVhost.length} of ${count} connections listed`);
      }
      return inVhost;
    },
    { timeout: 10_000, interval: 250 },
  );
  await Promise.all(
    connections.map(({ name }) => rabbitApi(`/connections/${encodeURIComponent(name)}`, 'DELETE')),
  );
}
