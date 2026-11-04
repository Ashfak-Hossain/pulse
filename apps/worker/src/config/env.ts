import { z } from 'zod';

const MAX_PORT = 65535;

function isBrokerAddress(value: string): boolean {
  const match = /^([^\s:]+):(\d+)$/.exec(value);
  if (!match) return false;
  const port = Number(match[2]);
  return port >= 1 && port <= MAX_PORT;
}

const replicaCount = z.coerce.number().int().min(1).default(1);

// One send carries the whole batch. Kafka's ~1 MB limit per partition batch can still be hit by
// large rows on one key
const MAX_BATCH_SIZE = 1000;

// Defaults fit local dev: one Kafka broker from Compose
const envSchema = z
  .object({
    KAFKA_BROKERS: z
      .string()
      .default('127.0.0.1:9092')
      .transform((list) => list.split(',').map((broker) => broker.trim()))
      .pipe(z.array(z.string().refine(isBrokerAddress, 'expected host:port'))),
    KAFKA_CLIENT_ID: z.string().min(1).default('pulse-worker'),
    KAFKA_REPLICATION_FACTOR: replicaCount,
    KAFKA_MIN_INSYNC_REPLICAS: replicaCount,
    // No default: a guessed database address could connect somewhere it should not
    RELAY_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(MAX_BATCH_SIZE).default(100),
    RELAY_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(500),
    // No default either: it holds the broker password
    AMQP_URL: z.url({ protocol: /^amqps?$/ }),
  })
  // More in-sync replicas than copies would make every acks=all write fail
  .refine((env) => env.KAFKA_MIN_INSYNC_REPLICAS <= env.KAFKA_REPLICATION_FACTOR, {
    path: ['KAFKA_MIN_INSYNC_REPLICAS'],
    message: 'must not be above KAFKA_REPLICATION_FACTOR',
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment at startup and throws if anything is wrong. The error lists keys
 * only, never values, because values can be secrets.
 */
export function validateEnv(source: Record<string, unknown>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
