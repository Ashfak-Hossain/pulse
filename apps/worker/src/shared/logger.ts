import { pino, type DestinationStream, type LevelWithSilent, type Logger } from 'pino';

// Fields that can hold a secret or personal data print as [Redacted], at the top level and one
// level down only, so log flat fields. Errors never go in as objects: pino would print their
// cause; use describeError
const REDACTED_FIELDS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'url',
  'connectionString',
  'email',
];

// The methods features need, so their tests can pass a fake instead of pino. debug is optional:
// it prints whole objects (events, jobs, emails), only with LOG_LEVEL=debug in development
export interface BasicLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  debug?(fields: Record<string, unknown>, message: string): void;
}

export interface LoggerOptions {
  level?: LevelWithSilent;
  // Tests pass their own; the default is stdout
  destination?: DestinationStream;
}

/** JSON logs, one object per line, with the level as a word ("info") instead of a number. */
export function createLogger({ level = 'info', destination }: LoggerOptions = {}): Logger {
  return pino(
    {
      name: 'pulse-worker',
      level,
      formatters: { level: (label) => ({ level: label }) },
      redact: REDACTED_FIELDS.flatMap((field) => [field, `*.${field}`]),
    },
    destination,
  );
}
