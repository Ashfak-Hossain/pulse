import { z } from 'zod';

// One problem Zod found: where (dot path, e.g. "riders.0.weight"), which rule, and why
export const apiIssueSchema = z.strictObject({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

// The body of every error the API sends. Strict, so a field that leaks in (a stack trace,
// a SQL error) makes the tests fail
export const apiErrorSchema = z.strictObject({
  statusCode: z.int().min(400).max(599),
  error: z.string(),
  message: z.string(),
  issues: z.array(apiIssueSchema).optional(),
});

export type ApiIssue = z.infer<typeof apiIssueSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
