import { parseEvent, type PulseEvent } from '@pulse/events';
import type { z } from 'zod';

// Events carry ids and short facts, never files. Checked before JSON.parse, so a huge record
// costs no parse time
export const MAX_RECORD_BYTES = 64 * 1024;

// What a consumer should do with a record: handle it, or skip it with a log line
export type DecodedRecord =
  | { kind: 'ok'; event: PulseEvent }
  | { kind: 'unknown'; type: string; version: number }
  // reason holds field paths and rule codes only, never values, so it is safe to log
  | { kind: 'invalid'; reason: string };

/** Turns a Kafka record's value into an event. Never throws. */
export function decodeRecord(value: Buffer | null | undefined): DecodedRecord {
  if (value === null || value === undefined || value.length === 0) {
    return { kind: 'invalid', reason: 'empty record' };
  }
  if (value.length > MAX_RECORD_BYTES) {
    return { kind: 'invalid', reason: `larger than ${MAX_RECORD_BYTES} bytes` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(value.toString('utf8'));
  } catch {
    // JSON.parse's message quotes the text near the error, so it is not kept
    return { kind: 'invalid', reason: 'not JSON' };
  }

  const parsed = parseEvent(raw);
  switch (parsed.kind) {
    case 'ok':
      return { kind: 'ok', event: parsed.event };
    case 'unknown':
      return { kind: 'unknown', type: parsed.type, version: parsed.version };
    case 'invalid':
      return { kind: 'invalid', reason: describeIssues(parsed.error.issues) };
  }
}

function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.code}`)
    .join('; ');
}
