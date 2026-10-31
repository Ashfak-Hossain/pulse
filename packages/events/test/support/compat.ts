import { isDeepStrictEqual } from 'node:util';

export interface JsonSchema {
  [keyword: string]: unknown;
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

// Lists every change from baseline to current that would break a reader of old events.
// Events are add-only: a field may be added only if it is optional, because events already in
// Kafka (and replays of them) do not have it. Nothing may be removed, renamed, retyped or made
// optional, because consumers written against the baseline rely on it.
// It recurses into object properties only: items, anyOf and the rest are compared as a whole, so
// a change inside an array of objects is reported even when it is add-only. Strict, but safe
export function breakingChanges(baseline: JsonSchema, current: JsonSchema, path = '$'): string[] {
  const { properties: oldProps = {}, required: oldRequired = [], ...oldRest } = baseline;
  const { properties: newProps = {}, required: newRequired = [], ...newRest } = current;
  const problems: string[] = [];

  if (!isDeepStrictEqual(withoutLibraryPattern(oldRest), withoutLibraryPattern(newRest))) {
    problems.push(`${path}: type or format changed`);
  }

  for (const [name, oldSchema] of Object.entries(oldProps)) {
    const newSchema = newProps[name];
    if (newSchema === undefined) problems.push(`${path}.${name}: removed`);
    else problems.push(...breakingChanges(oldSchema, newSchema, `${path}.${name}`));
  }
  for (const name of oldRequired) {
    if (name in newProps && !newRequired.includes(name)) {
      problems.push(`${path}.${name}: no longer required`);
    }
  }
  for (const name of newRequired) {
    if (!oldRequired.includes(name)) problems.push(`${path}.${name}: new required field`);
  }
  return problems;
}

// For `format: uuid` or `date-time`, Zod also writes its own regex as `pattern`. The format is
// the contract; the regex is a Zod detail that an upgrade may rewrite without changing meaning
function withoutLibraryPattern(keywords: Record<string, unknown>): Record<string, unknown> {
  if (!('format' in keywords)) return keywords;
  const rest = { ...keywords };
  delete rest.pattern;
  return rest;
}
