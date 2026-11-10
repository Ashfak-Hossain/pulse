import { createServer } from 'node:net';
import { GenericContainer, Wait } from 'testcontainers';

export type TestKafka = {
  // host:port for clients on the laptop (the HOST listener)
  brokers: string[];
  stop: () => Promise<void>;
};

// The image Compose runs (infra/compose/compose.yaml), so tests prove what we run.
// @testcontainers/kafka only knows Confluent's cp-kafka images, hence GenericContainer
const image = 'apache/kafka-native:4.4.0';

// Kafka tells clients which address to use (the advertised listener), and it must be the port
// on the laptop. Docker picks that port only at start, too late to advertise it, so pick a free
// one first and map it 1:1
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('Could not find a free port'));
      });
    });
  });
}

/** Tests only (`@pulse/events/testing`; the apps never import it): an empty single-node Kafka. */
export async function startTestKafka(): Promise<TestKafka> {
  const port = await freePort();
  const container = await new GenericContainer(image)
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      // Same settings as Compose except the internal listener (BROKER://localhost here) and no
      // volume, so each run starts empty
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENERS: 'HOST://:9092,BROKER://:19092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `HOST://127.0.0.1:${port},BROKER://localhost:19092`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'HOST:PLAINTEXT,BROKER:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'BROKER',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_SHARE_COORDINATOR_STATE_TOPIC_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .start();

  return {
    brokers: [`127.0.0.1:${port}`],
    stop: async () => {
      await container.stop();
    },
  };
}
