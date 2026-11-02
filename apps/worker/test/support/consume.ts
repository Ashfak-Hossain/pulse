import { randomUUID } from 'node:crypto';
import { Consumer, stringDeserializers, type Message } from '@platformatic/kafka';

export type StringMessage = Message<string, string, string, string>;

/** Reads a topic from the start with a fresh consumer group until `count` records arrived. */
export async function readMessages(
  brokers: string[],
  topic: string,
  count: number,
): Promise<StringMessage[]> {
  const consumer = new Consumer({
    groupId: `test-${randomUUID()}`,
    clientId: 'test-consumer',
    bootstrapBrokers: brokers,
    deserializers: stringDeserializers,
  });
  const stream = await consumer.consume({ topics: [topic], mode: 'earliest' });
  const messages: StringMessage[] = [];
  try {
    for await (const message of stream) {
      messages.push(message);
      if (messages.length === count) break;
    }
  } finally {
    await stream.close();
    await consumer.close();
  }
  return messages;
}
