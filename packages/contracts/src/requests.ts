import { z } from 'zod';

// What a free-text ride request means, shared by the rule parser and the future model
// (docs/plan/09-ai-and-ml.md §2.1). Every field is optional: a parser fills only what it found.
export const travelModes = [
  'cng',
  'rickshaw',
  'ride_hail_car',
  'own_car',
  'own_bike',
  'bus',
  'shuttle',
] as const;
export const travelModeSchema = z.enum(travelModes);

// An H3 cell at resolution 8, as h3-js writes it: 15 lowercase hex digits starting with 88
export const h3Res8CellSchema = z.string().regex(/^88[0-9a-f]{13}$/);

export const parsedPlaceSchema = z.strictObject({
  name: z.string().min(1).max(80),
  cell: h3Res8CellSchema,
});

// The parser never knows what time it is now, so it returns a reference the API resolves later
export const timeRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('clock'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  }),
  z.strictObject({ kind: z.literal('after_class'), course: z.string().min(1).max(20).optional() }),
  z.strictObject({ kind: z.literal('now') }),
]);

export const parsedRequestSchema = z.strictObject({
  direction: z.enum(['to_campus', 'from_campus']).optional(),
  place: parsedPlaceSchema.optional(),
  timeRef: timeRefSchema.optional(),
  genderPref: z.enum(['any', 'same_gender']).optional(),
  maxWaitMin: z.int().min(0).max(60).optional(),
  modes: z.array(travelModeSchema).min(1).max(travelModes.length).optional(),
  confidence: z.number().min(0).max(1),
});

export type TravelMode = z.infer<typeof travelModeSchema>;
export type ParsedPlace = z.infer<typeof parsedPlaceSchema>;
export type TimeRef = z.infer<typeof timeRefSchema>;
export type ParsedRequest = z.infer<typeof parsedRequestSchema>;
