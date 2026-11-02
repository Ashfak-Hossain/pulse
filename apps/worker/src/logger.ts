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
