import { z } from 'zod';
import { userRoleSchema, userStatusSchema } from './auth.js';

// The signed-in user's own profile, preferences, vehicles and trusted contacts. Names, phone
// numbers and plates are personal data: the API never logs them or puts them in a URL

// No control or bidi-override characters: they can disguise a name in lists
const visibleText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u, 'Text has hidden characters');

// E.164: a plus, a country code that does not start with 0, then 8 to 15 digits in all
const phoneSchema = z
  .string()
  .regex(
    /^\+[1-9]\d{7,14}$/,
    'Use international format: a plus, the country code, then the number',
  );

export const genderSchema = z.enum(['female', 'male', 'unspecified']);
export const travelModeSchema = z.enum([
  'cng',
  'rickshaw',
  'ride_hail_car',
  'own_car',
  'own_bike',
  'bus',
  'shuttle',
]);

// Route params of /me/vehicles/:id and /me/trusted-contacts/:id
export const meItemParamsSchema = z.strictObject({ id: z.uuid() });

// A PATCH must change something
const someField = (body: Record<string, unknown>) => Object.keys(body).length > 0;

export const meSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
  campus: z.strictObject({ id: z.uuid(), slug: z.string(), name: z.string() }),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  gender: genderSchema.nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
});

// Body of PATCH /me. Names and gender can be changed but not cleared (an active user needs
// them); department and phone can be cleared with null
export const updateMeSchema = z
  .strictObject({
    firstName: visibleText(100),
    lastName: visibleText(100),
    gender: genderSchema,
    department: visibleText(100).nullable(),
    phone: phoneSchema.nullable(),
  })
  .partial()
  .refine(someField, 'Nothing to change');

// Clock time in the campus timezone, HH:MM
const clockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const quietHoursSchema = z.strictObject({ start: clockSchema, end: clockSchema });

// Body of PUT /me/preferences: the whole set every time. The exact home pin is turned into a
// coarse H3 cell on the server and thrown away; it is never stored or returned
export const putPreferencesSchema = z.strictObject({
  home: z.strictObject({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
  genderPref: z.enum(['any', 'same_gender']),
  modes: z
    .array(travelModeSchema)
    .min(1)
    .max(7)
    .refine((modes) => new Set(modes).size === modes.length, 'Modes must not repeat'),
  maxWaitMin: z.int().min(0).max(60),
  maxDetourPct: z.int().min(0).max(50),
  autopilotOn: z.boolean(),
  quietHours: quietHoursSchema.nullable().default(null),
  dailyNotifyBudget: z.int().min(1).max(20),
  shareTextForTraining: z.boolean(),
});

// What GET and PUT /me/preferences answer: the home as its zone, never as a point
export const preferencesSchema = putPreferencesSchema.omit({ home: true }).extend({
  homeZone: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  quietHours: quietHoursSchema.nullable(),
});

export const vehicleTypeSchema = z.enum(['car', 'bike']);
const seatsFitType = (vehicle: { type?: string; seats?: number }) =>
  vehicle.type === undefined ||
  vehicle.seats === undefined ||
  (vehicle.type === 'car' ? vehicle.seats <= 6 : vehicle.seats === 1);
const seatsMessage = { message: 'A car has 1 to 6 free seats, a bike exactly 1', path: ['seats'] };

export const vehicleSchema = z.strictObject({
  id: z.uuid(),
  type: vehicleTypeSchema,
  seats: z.int(),
  plate: z.string(),
  color: z.string(),
});
export const vehicleListSchema = z.strictObject({ items: z.array(vehicleSchema) });
const vehicleFields = z.strictObject({
  type: vehicleTypeSchema,
  seats: z.int().min(1).max(6),
  plate: visibleText(32),
  color: visibleText(30),
});
export const createVehicleSchema = vehicleFields.refine(seatsFitType, seatsMessage);
// Seats and type that only clash with the stored row are refused by the database (422)
export const updateVehicleSchema = vehicleFields
  .partial()
  .refine(someField, 'Nothing to change')
  .refine(seatsFitType, seatsMessage);

export const trustedContactSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  phone: z.string(),
  relation: z.string(),
});
export const trustedContactListSchema = z.strictObject({ items: z.array(trustedContactSchema) });
export const createTrustedContactSchema = z.strictObject({
  name: visibleText(100),
  phone: phoneSchema,
  // e.g. mother, roommate
  relation: visibleText(40),
});

export type MeItemParams = z.infer<typeof meItemParamsSchema>;
export type Me = z.infer<typeof meSchema>;
export type UpdateMe = z.infer<typeof updateMeSchema>;
export type PutPreferences = z.output<typeof putPreferencesSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type Vehicle = z.infer<typeof vehicleSchema>;
export type VehicleList = z.infer<typeof vehicleListSchema>;
export type CreateVehicle = z.infer<typeof createVehicleSchema>;
export type UpdateVehicle = z.infer<typeof updateVehicleSchema>;
export type TrustedContact = z.infer<typeof trustedContactSchema>;
export type TrustedContactList = z.infer<typeof trustedContactListSchema>;
export type CreateTrustedContact = z.infer<typeof createTrustedContactSchema>;
