import { z } from 'zod';

// 32 random bytes or more, URL-safe (openssl rand -hex 32), so a placeholder cannot pass
const secret = z.string().regex(/^[A-Za-z0-9_-]{43,512}$/, 'must be 43+ letters, digits, - or _');

// Settings the API reads from the environment. Env values are always strings, so PORT is coerced
const envSchema = z
  .object({
    // No default: a deploy that forgets it must not boot as development and log sign-in codes
    NODE_ENV: z.enum(['development', 'test', 'production']),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // The app role (pulse_app), never the owner: row-level security only limits pulse_app
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    // Stand-in for the platform_admin role until that role exists. Unset = admin routes answer 401
    ADMIN_TOKEN: secret.optional(),
    // Sign-in rate-limit counters. Sign-in answers 503 while Redis is down, never "allowed"
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    // Keys every code hash and IP hash. Changing it voids every code still waiting to be used
    OTP_PEPPER: secret,
    // Signs every access token. Whoever has it can sign in as anyone; changing it signs everyone out
    JWT_SECRET: secret,
    // The web app's origin; every request that changes something must carry it (OriginGuard)
    APP_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .refine(
        (value) => URL.canParse(value) && new URL(value).origin === value,
        'must be scheme://host[:port] only',
      ),
  })
  // One secret per job: a leaked pepper (it keys hashes stored in the database) must not sign tokens
  .refine((env) => env.JWT_SECRET !== env.OTP_PEPPER, {
    path: ['JWT_SECRET'],
    message: 'must differ from OTP_PEPPER',
  })
  // Codes only go to the log until the email mailer lands: never in production
  .refine((env) => env.NODE_ENV !== 'production', {
    path: ['NODE_ENV'],
    message: 'production needs the email OTP mailer; codes only go to the log today',
  });

export type Env = z.infer<typeof envSchema>;

// ConfigModule calls this once at startup with the merged env (process env + .env file).
// Throwing stops the boot. The message names keys only: values may hold passwords
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid environment:\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
