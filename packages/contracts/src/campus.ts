import { z } from 'zod';

// A campus's public, URL-safe name: lowercase words joined by single hyphens (aiub, north-south)
export const campusSlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// Route params of /campuses/:slug
export const campusParamsSchema = z.strictObject({ slug: campusSlugSchema });

// A campus as clients see it. Not the database row: no created_at, and the PostGIS point
// becomes plain latitude/longitude
export const campusSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: campusSlugSchema,
  emailDomains: z.array(z.string()),
  timezone: z.string(),
  location: z.strictObject({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  }),
});

// Wrapped in an object, so fields such as a page cursor can be added without breaking clients
export const campusListSchema = z.strictObject({ items: z.array(campusSchema) });

export type CampusParams = z.infer<typeof campusParamsSchema>;
export type Campus = z.infer<typeof campusSchema>;
export type CampusList = z.infer<typeof campusListSchema>;
