import { z } from 'zod';

// Lowercased here, so every layer below sees one spelling per address. 254 is the longest
// address SMTP can deliver
const signInEmailSchema = z.email().max(254).toLowerCase();

export const userRoleSchema = z.enum(['student', 'faculty', 'staff', 'operator', 'campus_admin']);
export const userStatusSchema = z.enum(['pending_profile', 'active', 'suspended', 'deleted']);

/** Body of POST /auth/otp/request. */
export const otpRequestBodySchema = z.strictObject({ email: signInEmailSchema });
export type OtpRequestBody = z.infer<typeof otpRequestBodySchema>;

/** Same answer whether or not the address can sign in, so nobody can probe for accounts. */
export const otpRequestAcceptedSchema = z.strictObject({ expiresInSec: z.int().positive() });
export type OtpRequestAccepted = z.infer<typeof otpRequestAcceptedSchema>;

/** Body of POST /auth/otp/verify. The code stays text: a number would drop leading zeros. */
export const otpVerifyBodySchema = z.strictObject({
  email: signInEmailSchema,
  code: z.string().regex(/^\d{6}$/),
});
export type OtpVerifyBody = z.infer<typeof otpVerifyBodySchema>;

/** The signed-in user as the API returns it: only what sign-in decides, no profile fields. */
export const authUserSchema = z.strictObject({
  id: z.uuid(),
  campusId: z.uuid(),
  email: z.string(),
  role: userRoleSchema,
  status: userStatusSchema,
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** isNew is true when this verify created the account. Onboarding follows user.status. */
export const otpVerifyResultSchema = z.strictObject({ user: authUserSchema, isNew: z.boolean() });
export type OtpVerifyResult = z.infer<typeof otpVerifyResultSchema>;
