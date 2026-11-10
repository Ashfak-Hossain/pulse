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
    // The notifier's own role (pulse_notifier): it records processed_event and nothing else
    NOTIFIER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // The email worker's own role (pulse_mailer): email_delivery, and campus names to read
    MAILER_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // No default: it can hold the mail server's password. smtps = TLS from the start
    SMTP_URL: z.url({ protocol: /^smtps?$/ }),
    MAIL_FROM: z.email(),
    // Platform ops: who hears about a new campus, until admin users exist
    OPS_MAIL_TO: z.email(),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // debug prints whole events, jobs and emails at each step, for following one in dev
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  // Debug logs hold event payloads and email addresses; production logs must not
  .refine((env) => !(env.NODE_ENV === 'production' && env.LOG_LEVEL === 'debug'), {
    path: ['LOG_LEVEL'],
    message: 'debug is for development only, not with NODE_ENV=production',
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
