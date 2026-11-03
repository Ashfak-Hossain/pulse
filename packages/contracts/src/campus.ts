import { z } from 'zod';

// A campus's public, URL-safe name: lowercase words joined by single hyphens (aiub, north-south)
export const campusSlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// Query input for the public email-domain lookup. Never include the email in errors.
export const campusLookupQuerySchema = z.strictObject({ email: z.email() });
export type CampusLookupQuery = z.infer<typeof campusLookupQuerySchema>;

// Query strings arrive as text. Reject blanks before coercion, which would turn them into 0.
export const campusDistanceQuerySchema = z.strictObject({
  lat: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-90).max(90)),
  lng: z.string().trim().min(1).pipe(z.coerce.number<string>().min(-180).max(180)),
});
export const campusDistanceSchema = z.strictObject({
  slug: campusSlugSchema,
  distanceMetres: z.int().min(0),
});
export type CampusDistanceQuery = z.infer<typeof campusDistanceQuerySchema>;
export type CampusDistance = z.infer<typeof campusDistanceSchema>;

// Route params of /campuses/:slug
export const campusParamsSchema = z.strictObject({ slug: campusSlugSchema });

const locationSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// Lowercase, at least one dot (aiub.edu, student.aiub.edu). Not an email: sign-in matches the
// part after the @ against these
const emailDomainSchema = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);

// Area/Location, each part capitalised (Asia/Dhaka, America/Argentina/Buenos_Aires), or UTC.
// Intl alone also accepts any case (asia/dhaka), hence the shape check first
const timezoneShape = /^(?:UTC|[A-Z][A-Za-z_-]*(?:\/[A-Z][A-Za-z0-9_+-]*)+)$/;
// Intl.supportedValuesOf misses valid names (Asia/Kolkata, UTC); the formatter knows every zone
function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
const timezoneSchema = z
  .string()
  .max(64)
  .regex(timezoneShape)
  .refine(isTimeZone, 'Unknown time zone');

// A campus as clients see it. Not the database row: no created_at, and the PostGIS point
// becomes plain latitude/longitude
export const campusSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: campusSlugSchema,
  emailDomains: z.array(z.string()),
  timezone: z.string(),
  location: locationSchema,
});

// Wrapped in an object, so fields such as a page cursor can be added without breaking clients
export const campusListSchema = z.strictObject({ items: z.array(campusSchema) });

// Body of POST /admin/campuses. No id: the server makes it, so a client cannot pick one
export const createCampusSchema = z.strictObject({
  // No control or bidi-override characters: they can disguise a name in admin lists
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u, 'Name has hidden characters'),
  slug: campusSlugSchema,
  emailDomains: z
    .array(emailDomainSchema)
    .min(1)
    .max(10)
    .refine((domains) => new Set(domains).size === domains.length, 'Email domains must not repeat'),
  timezone: timezoneSchema,
  location: locationSchema,
});

export type CampusParams = z.infer<typeof campusParamsSchema>;
export type Campus = z.infer<typeof campusSchema>;
export type CampusList = z.infer<typeof campusListSchema>;
export type CreateCampus = z.infer<typeof createCampusSchema>;
