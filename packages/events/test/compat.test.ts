import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { eventSchema } from '../src/index.js';
import { breakingChanges, type JsonSchema } from './support/compat.js';

const schemasDir = new URL('../schemas/', import.meta.url);
const baselinePath = (type: string, version: number) =>
  new URL(`${type}.v${version}.json`, schemasDir);

// Input mode describes what a reader accepts: no additionalProperties: false (unknown fields are
// dropped, not rejected) and .default() fields optional, matching the tolerant reader
const jsonSchemaOf = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' }) as JsonSchema;

// The checker itself, on small hand-made schemas
describe('breakingChanges', () => {
  const v1: JsonSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      payload: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    required: ['id', 'payload'],
  };
  const withPayload = (payload: JsonSchema): JsonSchema => ({
    ...v1,
    properties: { ...v1.properties, payload },
  });

  it('finds nothing when the schema is unchanged', () => {
    expect(breakingChanges(v1, structuredClone(v1))).toEqual([]);
  });

  it('allows a new optional field', () => {
    const next = withPayload({
      type: 'object',
      properties: { name: { type: 'string' }, motto: { type: 'string' } },
      required: ['name'],
    });
    expect(breakingChanges(v1, next)).toEqual([]);
  });

  it('flags a removed field', () => {
    const next = withPayload({ type: 'object', properties: {}, required: [] });
    expect(breakingChanges(v1, next)).toEqual(['$.payload.name: removed']);
  });

  it('flags a rename as a removal plus a new required field', () => {
    const next = withPayload({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
    expect(breakingChanges(v1, next)).toEqual([
      '$.payload.name: removed',
      '$.payload.title: new required field',
    ]);
  });

  it('flags a new required field', () => {
    const next = withPayload({
      type: 'object',
      properties: { name: { type: 'string' }, motto: { type: 'string' } },
      required: ['name', 'motto'],
    });
    expect(breakingChanges(v1, next)).toEqual(['$.payload.motto: new required field']);
  });

  it('flags a changed type or format', () => {
    const next: JsonSchema = { ...v1, properties: { ...v1.properties, id: { type: 'number' } } };
    expect(breakingChanges(v1, next)).toEqual(['$.id: type or format changed']);
  });

  it('ignores a rewritten library regex when the format is unchanged', () => {
    const old: JsonSchema = { type: 'string', format: 'uuid', pattern: '^old$' };
    expect(breakingChanges(old, { ...old, pattern: '^new$' })).toEqual([]);
  });

  it('still flags a changed pattern on a field without a format', () => {
    const old: JsonSchema = { type: 'string', pattern: '^[a-z]+$' };
    expect(breakingChanges(old, { ...old, pattern: '^[0-9]+$' })).toEqual([
      '$: type or format changed',
    ]);
  });

  it('flags a required field that became optional', () => {
    const next = withPayload({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: [],
    });
    expect(breakingChanges(v1, next)).toEqual(['$.payload.name: no longer required']);
  });
});

// Every event against the JSON Schema committed when its version was first released.
// To record the baseline of a brand-new event or version (never to "fix" a failure):
// UPDATE_EVENT_SCHEMAS=1 pnpm --filter @pulse/events test
describe('event schemas stay add-only', () => {
  it.each(eventSchema.options.map((schema) => [schema.shape.type.value, schema]))(
    '%s keeps every field of its baseline',
    (_type, schema) => {
      const path = baselinePath(schema.shape.type.value, schema.shape.version.value);
      const current = jsonSchemaOf(schema);

      if (!existsSync(path)) {
        if (process.env.UPDATE_EVENT_SCHEMAS !== '1') {
          throw new Error(`No baseline at ${path.pathname}; record it with UPDATE_EVENT_SCHEMAS=1`);
        }
        writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
      }

      const baseline = JSON.parse(readFileSync(path, 'utf8')) as JsonSchema;
      expect(breakingChanges(baseline, current)).toEqual([]);
    },
  );

  // Otherwise deleting an event, or bumping its version in place, would quietly stop its check
  it('every baseline still has its event and version in eventSchema', () => {
    const registered = new Set(
      eventSchema.options.map((s) => `${s.shape.type.value}.v${s.shape.version.value}.json`),
    );
    const orphans = readdirSync(schemasDir).filter((file) => !registered.has(file));
    expect(orphans).toEqual([]);
  });
});
