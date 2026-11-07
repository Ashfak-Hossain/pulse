import { connect, type ChannelModel, type RecoveringChannelModel } from 'amqplib';
import type { Logger } from 'pino';
import { describeError } from '../shared/errors.js';

export type RabbitSetup = (model: ChannelModel) => Promise<void>;

export interface RabbitOptions {
  // Called when a reconnect fails in a way no retry can fix; the worker exits
  onFatal: (error: Error) => void;
  // Retries after a failed first try; tests pass 0 to fail at once
  startupRetries?: number;
}

// amqplib waits 100 ms and doubles that up to 5 s: about 25 s in all, enough for the broker to
// start. After that a wrong URL or password fails the deploy instead of retrying quietly
const STARTUP_RETRIES = 10;
const MAX_DELAY_MS = 5000;
// A host that never answers would otherwise hold each try for the OS timeout (minutes)
const CONNECT_TIMEOUT_MS = 10_000;

// Broker replies a retry cannot fix: 403 login refused, 406 a queue exists with other
// arguments, 530 no such vhost. A refused login has no code, only the reply in its message
const PERMANENT_CODES = new Set([403, 406, 530]);
const PERMANENT_REPLY = /\((ACCESS-REFUSED|NOT-ALLOWED)\)/;

/**
 * Connects to RabbitMQ, then reconnects forever if the connection drops. amqplib brings back
 * the connection, not its channels: `setup` runs after every connect and must declare the
 * topology and start the consumers again.
 */
export async function connectRabbit(
  url: string,
  logger: Logger,
  setup: RabbitSetup,
  { onFatal, startupRetries = STARTUP_RETRIES }: RabbitOptions,
): Promise<RecoveringChannelModel> {
  // waitForConnect: false returns at once, so the listeners below also see the first tries
  const connection = await connect(url, {
    timeout: CONNECT_TIMEOUT_MS,
    recovery: {
      initialMaxRetries: startupRetries,
      maxRetries: Number.POSITIVE_INFINITY,
      maxDelay: MAX_DELAY_MS,
      setup: async (model: ChannelModel) => {
        // amqplib adds its own error listener only after setup. A network cut in between would
        // emit an error nobody hears, and that crashes the worker
        model.on('error', () => {});
        await setup(model);
      },
      waitForConnect: false,
    },
  });

  let started = false;
  connection.on('connect', () => logger.info({}, 'RabbitMQ connected'));
  connection.on('connect-failed', (error) => {
    // At startup the retry budget ends this. Later, retrying forever would leave a worker that
    // looks alive but has no queues or consumers
    if (started && isPermanent(error)) onFatal(error);
    else logger.warn({ error: describeError(error) }, 'RabbitMQ connect failed');
  });
  connection.on('disconnect', (error) => {
    logger.warn({ error: describeError(error) }, 'RabbitMQ disconnected, reconnecting');
  });
  // With no listener, an error event would crash the worker; a disconnect follows it
  connection.on('error', (error) => {
    logger.warn({ error: describeError(error) }, 'RabbitMQ connection error');
  });
  // RabbitMQ stops taking published messages when it runs low on memory or disk
  connection.on('blocked', (reason) => logger.warn({ reason }, 'RabbitMQ blocked publishing'));
  connection.on('unblocked', () => logger.info({}, 'RabbitMQ unblocked publishing'));

  await connection.waitForConnect();
  started = true;
  return connection;
}

function isPermanent(error: Error): boolean {
  const code = 'code' in error ? error.code : undefined;
  return (
    (typeof code === 'number' && PERMANENT_CODES.has(code)) || PERMANENT_REPLY.test(error.message)
  );
}
