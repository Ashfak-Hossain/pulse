import {
  Admin,
  Consumer,
  ProduceAcks,
  Producer,
  stringSerializers,
  type Message,
  type MessagesStream,
} from '@platformatic/kafka';
import { backoffDelay } from '../shared/backoff.js';

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

export function createKafkaAdmin(connection: KafkaConnection): Admin {
  return new Admin(baseOptions(connection));
}

export function createKafkaProducer(
  connection: KafkaConnection,
): Producer<string, string, string, string> {
  return new Producer({
    ...baseOptions(connection),
    idempotent: true,
    acks: ProduceAcks.ALL,
    serializers: stringSerializers,
  });
}

// Raw bytes: the consumer checks a record's size before it parses it
export type RecordConsumer = Consumer<Buffer, Buffer, Buffer, Buffer>;
export type RecordStream = MessagesStream<Buffer, Buffer, Buffer, Buffer>;
export type ConsumedRecord = Message<Buffer, Buffer, Buffer, Buffer>;

/** A consumer in `groupId` that commits only when told to, after a record is handled. */
export function createKafkaConsumer(connection: KafkaConnection, groupId: string): RecordConsumer {
  return new Consumer({ ...baseOptions(connection), groupId, autocommit: false });
}

/**
 * Reads from the group's committed offsets, or from the start of each partition for a group that
 * has none yet. The library's default is the latest offset, which skips every record written
 * while the group had no running member (a deploy, a crash).
 */
export async function consumeCommitted(
  consumer: RecordConsumer,
  topicNames: string[],
): Promise<RecordStream> {
  return consumer.consume({
    topics: topicNames,
    mode: 'committed',
    fallbackMode: 'earliest',
    autocommit: false,
    // Records are handled one at a time and hold only short facts, so a small read-ahead is
    // plenty, and fewer records are read twice after a rebalance. Library defaults: 1024, 50 MB
    highWaterMark: 16,
    maxBytes: 1024 * 1024,
  });
}
