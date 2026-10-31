# 3. The journey of one request

Follow one request, `GET /campuses/aiub`, from the moment it reaches the API to the JSON it sends
back. Open each file as you read. Once this picture is clear, every other endpoint is the same
journey with different names.

## The whole trip on one page

```
 curl 127.0.0.1:3000/campuses/aiub
   │
   ▼
 ① main.ts             the app was started here: NestFactory.create(AppModule), listen on :3000
   │
   ▼
 ② helmet              (app.setup.ts) adds security headers to every response
   │
   ▼
 ③ router              Nest finds the controller whose route matches: @Controller('campuses') + @Get(':slug')
   │
   ▼
 ④ ZodValidationPipe   checks { slug: 'aiub' } against campusParamsSchema
   │                   ✗ bad slug ("AIUB") → 400 { …, issues: [{ path: 'slug', … }] }   ──┐
   ▼                                                                                     │
 ⑤ CampusController    get(params) → this.campuses.getBySlug('aiub')                     │
   │                                                                                     │
   ▼                                                                                     │
 ⑥ CampusService       SELECT … FROM campus WHERE slug = $1 LIMIT 1    ──► PostgreSQL    │
   │                   ✗ no row → throw NotFoundException('Campus not found')  ──────────┤
   │                   ✓ row → toCampus(row): {x, y} becomes { lat, lng }                │
   ▼                                                                                     ▼
 ⑦ Nest sends 200 + JSON                                 ⑧ HttpErrorFilter shapes every error:
                                                            { statusCode, error, message, issues? }
```

## Step by step

### ① The app is already running: `main.ts`

`pnpm --filter @pulse/api dev` ran [main.ts](../../apps/api/src/main.ts). It built the app from
`AppModule`, which lists every feature module, and started listening on `127.0.0.1:3000`.
Nothing in `main.ts` runs per request: it runs once at startup.

### ② Security headers: `app.setup.ts`

[`configureApp()`](../../apps/api/src/app.setup.ts) added `helmet()`, a middleware: a function that
runs on every request before the controller. It sets headers such as
`X-Content-Type-Options: nosniff` and removes `X-Powered-By: Express`.

### ③ Routing: which method answers?

Nest looks at every controller. [CampusController](../../apps/api/src/campus/campus.controller.ts)
says `@Controller('campuses')`, and its method `get` says `@Get(':slug')`. Together they match
`GET /campuses/<anything>`, and `:slug` captures `aiub`. So Nest will call `get(...)`.

If no route matches (`GET /nope`), Nest throws a `NotFoundException` and step ⑧ answers 404.

### ④ Validation: `ZodValidationPipe`

Before calling `get`, Nest runs the pipe on the method's parameter:

```ts
get(@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams)
```

`@Param()` collects the route params into `{ slug: 'aiub' }`. The
[pipe](../../apps/api/src/common/zod-validation.pipe.ts) checks it against `campusParamsSchema`
from [packages/contracts/src/campus.ts](../../packages/contracts/src/campus.ts): lowercase words
joined by single hyphens, at most 64 characters, and no other keys.

- Valid → the controller receives the parsed value.
- Invalid (`/campuses/AIUB`) → the pipe throws `BadRequestException` with an `issues` list, and
  the database is never asked.

### ⑤ The controller hands over

```ts
return this.campuses.getBySlug(params.slug);
```

The controller does no work itself. `this.campuses` is the `CampusService` that Nest created and
**injected** through the constructor (see [dependency injection](glossary.md)).

### ⑥ The service asks the database and maps the answer

[CampusService.getBySlug](../../apps/api/src/campus/campus.service.ts):

```ts
const [row] = await this.db.select().from(campus).where(eq(campus.slug, slug)).limit(1);
if (!row) {
  throw new NotFoundException('Campus not found');
}
return toCampus(row);
```

- `this.db` is the shared database pool from `DbModule`, injected with `@Inject(DATABASE)`.
- Drizzle turns the chain into SQL, roughly `select … from "campus" where "campus"."slug" = $1 limit $2`. The
  `$1` means `slug` is sent separately from the SQL text, so input can never change the query
  (no SQL injection).
- The API connects as the role `pulse_app`. Row-level security lets it read campuses (they are
  public), and would hide campus-scoped rows outside `withCampus()`.
- `toCampus(row)` turns the database row into the **contract**: PostGIS stores the point as
  `{ x: longitude, y: latitude }`; the client gets `{ lat, lng }`. `created_at` stays inside.

### ⑦ Success

The controller returns the object, Nest turns it into JSON and answers `200`:

```json
{
  "id": "b5bc33b9-…",
  "name": "American International University-Bangladesh",
  "slug": "aiub",
  "emailDomains": ["aiub.edu", "student.aiub.edu"],
  "timezone": "Asia/Dhaka",
  "location": { "lat": 23.8223, "lng": 90.4274 }
}
```

### ⑧ Failure: every error has one shape

Anything thrown anywhere in steps ③–⑥ lands in
[HttpErrorFilter](../../apps/api/src/common/http-error.filter.ts). It answers:

| Thrown                                   | Answer                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| `NotFoundException('Campus not found')`  | `404 { "statusCode": 404, "error": "Not Found", "message": "Campus not found" }`             |
| The pipe's `BadRequestException`         | `400 { …, "message": "Validation failed", "issues": [ … ] }`                                 |
| Anything else (a bug, the database down) | `500 { …, "message": "Internal Server Error" }`; the real reason goes to the server log only |

The client never sees a stack trace or a database message, and the log never gets query values
(they can be personal data).

## The same journey for your endpoint

When you build `GET /campuses/lookup?email=…`, the trip is identical:

| Step | Campus (`/campuses/:slug`)         | Yours (`/campuses/lookup?email=`)     |
| ---- | ---------------------------------- | ------------------------------------- |
| ③    | `@Get(':slug')`                    | `@Get('lookup')`                      |
| ④    | `@Param(new ZodValidationPipe(…))` | `@Query(new ZodValidationPipe(…))`    |
| ⑤    | `getBySlug(params.slug)`           | `lookupByEmail(query.email)`          |
| ⑥    | `where(eq(campus.slug, slug))`     | a query on `email_domains`            |
| ⑧    | 404 "Campus not found"             | 404 "No campus for this email domain" |

One catch for this example: `@Get('lookup')` must be declared **above** `@Get(':slug')` in the
controller, or Nest will treat `lookup` as a slug.
