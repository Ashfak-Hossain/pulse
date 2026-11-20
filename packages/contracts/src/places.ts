import { z } from 'zod';

// Gates, zones and meeting points of the caller's campus. The campus always comes from the
// session, never from the request, so no schema here has a campusId

// A place name as admins type it and riders see it (the database allows up to 100 characters).
// No control or bidi-override characters: they can disguise a name in lists
const placeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u, 'Name has hidden characters');

const locationSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// GeoJSON order: longitude first
const positionSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

// A closed ring: at least four positions, the last one the same as the first. The caps keep one
// request from sending PostgreSQL a huge shape to build
const ringSchema = z
  .array(positionSchema)
  .min(4)
  .max(1000)
  .refine((ring) => {
    const first = ring[0];
    const last = ring.at(-1);
    return (
      first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
    );
  }, 'A ring must end where it starts');

// Only the shape is checked here. Whether the rings cross each other is PostgreSQL's job
// (ST_IsValid), which answers 422
export const multiPolygonSchema = z.strictObject({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(ringSchema).min(1).max(20)).min(1).max(50),
});

export const meetingPointKindSchema = z.enum(['gate', 'landmark', 'bus_stop', 'junction']);

// Route params of /admin/gates/:id, /admin/zones/:id and /admin/meeting-points/:id
export const placeParamsSchema = z.strictObject({ id: z.uuid() });

// A PATCH must change something
const someField = <T extends Record<string, unknown>>(body: T) => Object.keys(body).length > 0;

export const gateSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  location: locationSchema,
  isPrimary: z.boolean(),
});
export const gateListSchema = z.strictObject({ items: z.array(gateSchema) });
export const createGateSchema = z.strictObject({
  name: placeNameSchema,
  location: locationSchema,
  isPrimary: z.boolean().default(false),
});
export const updateGateSchema = z
  .strictObject({
    name: placeNameSchema,
    location: locationSchema,
    isPrimary: z.boolean(),
  })
  .partial()
  .refine(someField, 'Nothing to change');

export const zoneSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  area: multiPolygonSchema,
});
export const zoneListSchema = z.strictObject({ items: z.array(zoneSchema) });
export const createZoneSchema = z.strictObject({ name: placeNameSchema, area: multiPolygonSchema });
export const updateZoneSchema = createZoneSchema.partial().refine(someField, 'Nothing to change');

export const meetingPointSchema = z.strictObject({
  id: z.uuid(),
  zoneId: z.uuid().nullable(),
  name: z.string(),
  kind: meetingPointKindSchema,
  location: locationSchema,
});
export const meetingPointListSchema = z.strictObject({ items: z.array(meetingPointSchema) });
export const meetingPointQuerySchema = z.strictObject({ zoneId: z.uuid().optional() });
export const createMeetingPointSchema = z.strictObject({
  name: placeNameSchema,
  kind: meetingPointKindSchema,
  location: locationSchema,
  // Null or left out: a gate-side point with no zone
  zoneId: z.uuid().nullable().default(null),
});
export const updateMeetingPointSchema = z
  .strictObject({
    name: placeNameSchema,
    kind: meetingPointKindSchema,
    location: locationSchema,
    zoneId: z.uuid().nullable(),
  })
  .partial()
  .refine(someField, 'Nothing to change');

export type PlaceParams = z.infer<typeof placeParamsSchema>;
export type MultiPolygon = z.infer<typeof multiPolygonSchema>;
export type Gate = z.infer<typeof gateSchema>;
export type GateList = z.infer<typeof gateListSchema>;
export type CreateGate = z.output<typeof createGateSchema>;
export type UpdateGate = z.output<typeof updateGateSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type ZoneList = z.infer<typeof zoneListSchema>;
export type CreateZone = z.output<typeof createZoneSchema>;
export type UpdateZone = z.output<typeof updateZoneSchema>;
export type MeetingPoint = z.infer<typeof meetingPointSchema>;
export type MeetingPointList = z.infer<typeof meetingPointListSchema>;
export type MeetingPointQuery = z.infer<typeof meetingPointQuerySchema>;
export type CreateMeetingPoint = z.output<typeof createMeetingPointSchema>;
export type UpdateMeetingPoint = z.output<typeof updateMeetingPointSchema>;
