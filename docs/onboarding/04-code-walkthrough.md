# 4. Code walkthrough, line by line

Every file of the API, in the order the app uses them. Open the real file next to this page: the
code here is copied from it. When a line is obvious, it is skipped.

- [main.ts](#maints-starting-the-app)
- [app.module.ts](#appmodulets-the-root-module)
- [app.setup.ts](#appsetupts-app-wide-http-setup)
- [config/env.ts](#configenvts-checking-the-settings)
- [db/db.module.ts](#dbdbmodulets-the-database-pool)
- [common/zod-validation.pipe.ts](#commonzod-validationpipets-checking-input)
- [common/http-error.filter.ts](#commonhttp-errorfilterts-one-shape-for-every-error)
- [contracts/src/campus.ts](#packagescontractssrccampusts-the-contract)
- [campus/ (module, controller, service)](#campus-the-feature-you-copy)
- [health/](#health-is-the-api-alive)
- [packages/db: schema and withCampus](#packagesdb-tables-and-withcampus)

---

## `main.ts`: starting the app

[apps/api/src/main.ts](../../apps/api/src/main.ts)

```ts
import 'reflect-metadata';
```

Must come first. Nest's decorators store information ("this constructor needs a
`CampusService`") as metadata on classes; this package makes that possible.

```ts
const app = await NestFactory.create(AppModule);
```

Builds the whole app from the root module: reads every module it imports, creates every
service, connects every controller to its routes. `await` works at the top of the file because
the package is ESM (`"type": "module"`).

```ts
configureApp(app);
```

App-wide HTTP setup (security headers). The e2e tests call the same function, so they test the
same app users get.

```ts
app.enableShutdownHooks();
```

On Ctrl+C (or when a server stops the process), Nest calls every `onApplicationShutdown()`; the
database module uses it to close its connections cleanly.

```ts
const config: ConfigService<Env, true> = app.get(ConfigService);
const host = config.get('HOST', { infer: true });
const port = config.get('PORT', { infer: true });
await app.listen(port, host);
```

Reads the already-checked settings (see `env.ts`) and starts listening for HTTP requests.
`ConfigService<Env, true>` tells TypeScript the settings exist and have the types from `Env`.

---

## `app.module.ts`: the root module

[apps/api/src/app.module.ts](../../apps/api/src/app.module.ts)

A **module** is a box that groups related code. The root module lists every box the app has.

```ts
const rootEnvFile = fileURLToPath(new URL('../../../.env', import.meta.url));
```

The path of the repo-root `.env`, worked out from where this file is, so it works from both
`src/` and the compiled `dist/`.

```ts
ConfigModule.forRoot({
  isGlobal: true,          // every module can inject ConfigService without importing ConfigModule
  cache: true,             // read each setting once
  envFilePath: rootEnvFile,
  validate: validateEnv,   // check the settings at startup; a bad one stops the app
}),
HealthModule,
DbModule,
CampusModule,
```

`imports` lists the modules. Your feature module goes here; `nest g module` adds it for you
(then add `.js` to the import path).

```ts
providers: [{ provide: APP_FILTER, useClass: HttpErrorFilter }],
```

Registers the error filter for the whole app. Registered here (not in `main.ts`) so every app
built from `AppModule`, including the tests, gets it.

---

## `app.setup.ts`: app-wide HTTP setup

[apps/api/src/app.setup.ts](../../apps/api/src/app.setup.ts)

```ts
export function configureApp(app: INestApplication): void {
  app.use(helmet());
}
```

`app.use` adds a middleware that runs on every request. `helmet()` sets a dozen standard
security headers. Future app-wide settings (CORS for the web app) go in this function.

---

## `config/env.ts`: checking the settings

[apps/api/src/config/env.ts](../../apps/api/src/config/env.ts)

```ts
const envSchema = z.object({
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});
```

A Zod schema for the settings. Settings arrive as text, so `z.coerce.number()` turns `"3000"`
into `3000`. `.default(...)` fills a missing value. `DATABASE_URL` has no default: without it the
app must not start.

```ts
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
```

`safeParse` returns success or a list of problems instead of throwing. The error message names
the **keys** only, never the values, because a value can be a password.

---

## `db/db.module.ts`: the database pool

[apps/api/src/db/db.module.ts](../../apps/api/src/db/db.module.ts)

```ts
export const DATABASE = Symbol('DATABASE');
```

A unique name ("token") for the database client. Services ask for it with
`@Inject(DATABASE)`.

```ts
@Global()
@Module({ providers: [{ provide: DATABASE, inject: [ConfigService], useFactory: async (config) => { … } }], exports: [DATABASE] })
```

- `@Global()`: every module can inject `DATABASE` without importing `DbModule`. That is why
  `CampusModule` does not import it.
- `useFactory`: Nest calls this function once at startup and shares what it returns.

Inside the factory:

```ts
const db = createDb(config.get('DATABASE_URL', { infer: true }), {
  connectionTimeoutMillis: 2000,
  statement_timeout: 5000,
  query_timeout: 5000,
});
```

One **pool** of connections for the whole process: each query borrows a connection and returns
it. The timeouts stop a hung database from hanging the API.

```ts
db.$client.on('error', (error) => logger.error(`Idle connection failed: ${error.message}`));
await assertRestrictedRole(db);
```

- Without an error listener, a broken idle connection would crash Node.
- `assertRestrictedRole` refuses to start if `DATABASE_URL` connects as a role that bypasses
  row-level security (like the owner `pulse`). The API must connect as `pulse_app`.

```ts
async onApplicationShutdown(): Promise<void> {
  await this.db.$client.end();
}
```

Closes every connection when the app stops.

---

## `common/zod-validation.pipe.ts`: checking input

[apps/api/src/common/zod-validation.pipe.ts](../../apps/api/src/common/zod-validation.pipe.ts)

```ts
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}
```

A pipe takes one schema. `<T extends z.ZodType>` is a generic: the pipe works with any schema,
and TypeScript knows the output type of the one you pass.

```ts
transform(value: unknown): z.output<T> {
  const result = this.schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
```

Nest calls `transform` with the raw input (body, query or params). On success the controller gets
the **parsed** value: defaults filled, numbers coerced, unknown keys rejected.

```ts
  const body: ApiError = { statusCode: 400, error: 'Bad Request', message: 'Validation failed', issues: … };
  throw new BadRequestException(body);
```

On failure, a 400 with one entry per problem: `path` (which field), `code` (which rule) and a
`message`. Typed as `ApiError`, so it always matches the error contract.

How you use it:

```ts
@Body(new ZodValidationPipe(createThingSchema)) body: CreateThing      // JSON body
@Query(new ZodValidationPipe(lookupQuerySchema)) query: LookupQuery    // ?email=…
@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams // /:slug
```

---

## `common/http-error.filter.ts`: one shape for every error

[apps/api/src/common/http-error.filter.ts](../../apps/api/src/common/http-error.filter.ts)

You will not change this file, but you should know what it does to the errors you throw.

```ts
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
```

`@Catch()` with nothing inside catches **everything** thrown while handling a request.

```ts
catch(exception: unknown, host: ArgumentsHost): void {
  const body = toBody(exception);
  if (body.statusCode >= 500) {
    this.logger.error(`${request.method} ${request.path} failed: ${describe(exception)}`);
  }
  …
  httpAdapter.reply(response, body, body.statusCode);
}
```

Builds the answer, logs server errors (method and path only: the query string may hold personal
data), and sends the answer.

`toBody` decides what the client sees:

- `HttpException` with a 4xx status (`NotFoundException`, `BadRequestException`…): its message,
  and `issues` if they match the contract.
- Anything else, or any 5xx: fixed text (`Internal Server Error`). The real reason goes to the
  log only, because it can name hosts, users or data.

`describe` decides what the **log** gets: for a failed database query, only the SQL text and the
PostgreSQL error code, never the query's values.

---

## `packages/contracts/src/campus.ts`: the contract

[packages/contracts/src/campus.ts](../../packages/contracts/src/campus.ts)

```ts
export const campusSlugSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
```

The regex reads: one or more lowercase letters or digits, then any number of groups of "a hyphen
followed by letters or digits". So `aiub` and `north-south` pass; `AIUB`, `a_b`, `-aiub`,
`aiub-` and `a--b` fail.

```ts
export const campusParamsSchema = z.strictObject({ slug: campusSlugSchema });
```

`strictObject`: any key not listed is an error. Every request schema is strict (rule 11).

```ts
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
export const campusListSchema = z.strictObject({ items: z.array(campusSchema) });
```

What a client receives. Not the database row: no `created_at`, and the point is plain
latitude/longitude. The list is wrapped in `{ items }` so we can add a page cursor later without
breaking clients.

```ts
export type Campus = z.infer<typeof campusSchema>;
```

`z.infer` turns a schema into a TypeScript type, so the type and the runtime check can never
disagree. New schemas are also exported from `src/index.ts`.

---

## `campus/`: the feature you copy

Three files, one job each.

### `campus.module.ts`

[apps/api/src/campus/campus.module.ts](../../apps/api/src/campus/campus.module.ts)

```ts
@Module({
  controllers: [CampusController],
  providers: [CampusService],
})
export class CampusModule {}
```

Tells Nest: this feature has one controller and one service. Nest creates the service and
injects it into the controller.

### `campus.controller.ts`: HTTP only

[apps/api/src/campus/campus.controller.ts](../../apps/api/src/campus/campus.controller.ts)

```ts
@Controller('campuses')
export class CampusController {
  constructor(private readonly campuses: CampusService) {}
```

- `@Controller('campuses')`: every route in this class starts with `/campuses`. Routes are plural
  nouns.
- The constructor asks for a `CampusService`; Nest hands one in (dependency injection).
  `private readonly campuses` declares and sets the field in one go. `CampusService` is imported
  normally (not `import type`), because Nest needs the real class at runtime.

```ts
@Get()
list(): Promise<CampusList> {
  return this.campuses.list();
}

@Get(':slug')
get(@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams): Promise<Campus> {
  return this.campuses.getBySlug(params.slug);
}
```

- `@Get()` → `GET /campuses`. `@Get(':slug')` → `GET /campuses/:slug`.
- The return types (`Promise<Campus>`) come from the contract, so TypeScript stops you returning
  the wrong shape.
- No `try/catch`: errors go to the global filter.

### `campus.service.ts`: logic and queries

[apps/api/src/campus/campus.service.ts](../../apps/api/src/campus/campus.service.ts)

```ts
type CampusRow = typeof campus.$inferSelect;
```

The TypeScript type of one row of the `campus` table, taken from the Drizzle schema.

```ts
const CAMPUS_LIST_LIMIT = 200;
```

Every list has a hard cap: a public endpoint must never return a whole table.

```ts
@Injectable()
export class CampusService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
```

`@Injectable()` lets Nest create it. `@Inject(DATABASE)` asks for the shared pool by its token.

```ts
async list(): Promise<CampusList> {
  const rows = await this.db
    .select()
    .from(campus)
    .orderBy(asc(campus.name), asc(campus.slug))
    .limit(CAMPUS_LIST_LIMIT);
  return { items: rows.map(toCampus) };
}
```

`select … from campus order by name, slug limit 200`. Names can repeat, so the order ends on a
unique column (`slug`), which makes it the same every time.

```ts
async getBySlug(slug: string): Promise<Campus> {
  const [row] = await this.db.select().from(campus).where(eq(campus.slug, slug)).limit(1);
  if (!row) {
    throw new NotFoundException('Campus not found');
  }
  return toCampus(row);
}
```

- `const [row] = …` takes the first element of the result array. Because of
  `noUncheckedIndexedAccess`, TypeScript knows `row` may be `undefined`, so you must check it.
- `eq(campus.slug, slug)` sends `slug` as a parameter (`$1`), never inside the SQL text.

```ts
function toCampus(row: CampusRow): Campus {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    emailDomains: row.emailDomains,
    timezone: row.timezone,
    location: { lat: row.location.y, lng: row.location.x },
  };
}
```

Row → contract, field by field. Copying fields one by one (never `...row`) means a column added
later cannot leak to clients by accident.

---

## `health/`: is the API alive?

[apps/api/src/health/health.controller.ts](../../apps/api/src/health/health.controller.ts)

- `GET /health` is **liveness**: the process runs. It never touches the database.
- `GET /health/ready` is **readiness**: it runs `select 1`. If PostgreSQL does not answer it sets
  status 503 itself (`res.status(…)`) and returns `{ status: 'error', … }`. It does not throw,
  because the error filter would replace its body; readiness is a report, not an error.

---

## `packages/db`: tables and `withCampus`

You read these more than you change them.

**[schema.ts](../../packages/db/src/schema.ts)** describes each table in TypeScript:

```ts
export const campus = pgTable('campus', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  emailDomains: text('email_domains').array().notNull(),
  location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
  …
}, () => [ pgPolicy('campus_read', { for: 'select', to: pulseApp, using: sql`true` }), … ]);
```

The left name (`emailDomains`) is what TypeScript uses; the string (`'email_domains'`) is the
real column. `pgPolicy` lines are the row-level security rules. Changing a table means: edit
`schema.ts`, run `pnpm --filter @pulse/db db:generate` to write a migration, review the SQL, then
`db:migrate`. (Your course task does this, paired with Ashfak.)

**[campus-scope.ts](../../packages/db/src/campus-scope.ts)**: `withCampus(db, campusId, work)`
opens a transaction, tells PostgreSQL "this transaction is for campus X"
(`set_config('app.campus_id', …, true)`), and runs your queries inside it. Row-level security
then shows only that campus's rows. Any campus-scoped table (courses, trips) is used only like
this (a future example: the `course` table does not exist yet):

```ts
const courses = await withCampus(this.db, campusId, (tx) =>
  tx.select().from(course).orderBy(asc(course.code)).limit(COURSE_LIST_LIMIT),
);
```
