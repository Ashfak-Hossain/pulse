import { z } from 'zod';

/** An opaque page position: base64url of a small JSON object. Real ones stay far below 512. */
export const cursorTokenSchema = z
  .string()
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

/** A text value inside a decoded cursor. PostgreSQL text cannot hold \0, so it would 500. */
export const cursorTextSchema = z
  .string()
  .max(64)
  .refine((value) => !value.includes('\0'), 'Invalid text');

/** `?limit=` from a query string: digits only, 1..max, `fallback` when absent. */
export function pageLimitSchema(max: number, fallback: number) {
  return z
    .string()
    .regex(/^\d+$/)
    .pipe(z.coerce.number<string>().int().min(1).max(max))
    .default(fallback);
}
