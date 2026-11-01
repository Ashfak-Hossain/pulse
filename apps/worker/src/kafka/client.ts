import { Admin, ProduceAcks, Producer, stringSerializers } from '@platformatic/kafka';
import { backoffDelay } from './backoff.js';

export interface KafkaConnection {
  brokers: string[];
  clientId: string;
}

// About 33 s, enough for Kafka's startup. Not forever (the library default): the relay retries
// the outbox row on its next loop. After giving up, the producer gets a new id, so a resend can
// duplicate; consumers dedupe with processed_event
const RETRIES = 10;

function baseOptions({ brokers, clientId }: KafkaConnection) {
  return {
    clientId,
    bootstrapBrokers: brokers,
    retries: RETRIES,
    retryDelay: (_client: unknown, _operation: string, attempt: number) => backoffDelay(attempt),
  };
}

export function createAdmin(connection: KafkaConnection): Admin {
  return new Admin(baseOptions(connection));
}

export function createProducer(
  connection: KafkaConnection,
): Producer<string, string, string, string> {
  return new Producer({
    ...baseOptions(connection),
    idempotent: true,
    acks: ProduceAcks.ALL,
    serializers: stringSerializers,
  });
}
