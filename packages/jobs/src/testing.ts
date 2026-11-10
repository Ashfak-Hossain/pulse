import { GenericContainer, Wait } from 'testcontainers';

export type TestRabbit = {
  amqpUrl: string;
  // The management HTTP API, for what AMQP cannot do: read queue arguments, drop connections
  apiUrl: string;
  stop: () => Promise<void>;
};

// The image Compose runs (infra/compose/compose.yaml), so tests prove what we run
const image = 'rabbitmq:4.4-management-alpine';

// Throwaway login of the test broker, for test helpers that call the management API
export const testRabbitLogin = { user: 'pulse', password: 'pulse' } as const;

/** Tests only (`@pulse/jobs/testing`; the apps never import it): an empty RabbitMQ 4.4. */
export async function startTestRabbit(): Promise<TestRabbit> {
  const { user, password } = testRabbitLogin;
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
