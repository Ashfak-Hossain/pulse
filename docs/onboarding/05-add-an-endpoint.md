# 5. Add an endpoint: the recipe

Every endpoint is built the same way, in the same order. The campus endpoint
([apps/api/src/campus/](../../apps/api/src/campus/)) is the finished example: when in doubt, look
at how it does it.

```
 1 issue + branch  →  2 contract  →  3 test (fails)  →  4 controller + service  →  5 test (passes)
                                                                                         │
 9 PR  ←  8 all checks  ←  7 README row  ←  6 Postman request  ←─────────────────────────┘
```

The running example below is a made-up endpoint, `GET /campuses/:slug/summary`, so the code shows
the pattern without solving your task for you.

## 1. Issue and branch

Pick your issue on GitHub, assign yourself, then:

```sh
git switch main && git pull
git switch -c feat/campus-summary
```

## 2. The contract (`packages/contracts`)

Write down what comes in and what goes out, before any NestJS code.

```ts
// packages/contracts/src/campus.ts (or a new file for a new feature, e.g. src/fare.ts)

// What GET /campuses/:slug/summary answers
export const campusSummarySchema = z.strictObject({
  slug: campusSlugSchema,
  domainCount: z.int().min(0),
});
export type CampusSummary = z.infer<typeof campusSummarySchema>;
```

Export it from [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts), add unit
tests next to the others in `packages/contracts/test/`, then build the package so the API can see
it:

```sh
pnpm --filter @pulse/contracts test
pnpm --filter @pulse/contracts build
```

Rules for schemas:

| Input comes from  | Use                                           | Why                                                        |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------- |
| Route `/:slug`    | `z.strictObject({ slug: … })`                 | Reject unknown keys                                        |
| Query `?lat=23.8` | `z.strictObject({ lat: z.coerce.number()… })` | Query values always arrive as text; `coerce` makes numbers |
| JSON body         | `z.strictObject({ … })`                       | Body numbers are already numbers: no `coerce`              |
| An email          | `z.email()`                                   | Do not write your own email regex                          |
| Money             | `z.int().min(0)` (paisa)                      | Never decimals for money (rule 6)                          |

Never put the input value into a custom error message.

**Gotcha with `z.coerce.number()`:** an empty value (`?lat=`) becomes `0`, not an error. Reject
empty text first, then coerce: `z.string().min(1).pipe(z.coerce.number().min(-90).max(90))`, and
test `?lat=` in your e2e test.

## 3. Write the test first (it fails)

Copy [apps/api/test/campuses.e2e-spec.ts](../../apps/api/test/campuses.e2e-spec.ts) to
`apps/api/test/<feature>.e2e-spec.ts` and keep its skeleton:

- the `run` id and unique slugs (other test files share the database),
- the `beforeAll` that inserts rows as the owner and overrides `DATABASE` with the `pulse_app`
  pool,
- `configureApp(app)` before `app.init()`,
- `afterAll` with `app?.close()` and `owner?.$client.end()`.

Then write one `it(...)` per behaviour: the happy path, the 404, the 400 for bad input. Check
bodies with the contract (`campusSummarySchema.parse(res.body)`, `apiErrorSchema.parse(...)`).

```sh
pnpm --filter @pulse/api test:e2e
```

It fails with `expected 200 "OK", got 404 "Not Found"`: the route does not exist yet. Good: the
test can see the problem.

## 4. Controller and service

**A new feature?** Generate the module, controller and service, then trim:

```sh
cd apps/api
pnpm exec nest g module fare
pnpm exec nest g controller fare --no-spec
pnpm exec nest g service fare --no-spec
cd ../..
```

The generator writes imports without `.js`; add it everywhere it wrote one, including the new line
in `app.module.ts`.

**Adding to an existing feature?** Add a method to its controller and service.

The controller method: route, pipe, one call.

```ts
@Get(':slug/summary')
summary(@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams): Promise<CampusSummary> {
  return this.campuses.summary(params.slug);
}
```

The service method: query, check, map.

```ts
async summary(slug: string): Promise<CampusSummary> {
  const [row] = await this.db
    .select({ slug: campus.slug, emailDomains: campus.emailDomains })
    .from(campus)
    .where(eq(campus.slug, slug))
    .limit(1);
  if (!row) {
    throw new NotFoundException('Campus not found');
  }
  return { slug: row.slug, domainCount: row.emailDomains.length };
}
```

Checklist for the code:

- [ ] The controller has no query and no logic.
- [ ] A static route (`@Get('lookup')`) is declared **above** a route with a parameter
      (`@Get(':slug')`), or the parameter route swallows it.
- [ ] Lists: `.limit(…)` and an `orderBy` ending on a unique column; answer `{ items }`.
- [ ] Campus-scoped tables only inside `withCampus(...)`.
- [ ] The answer is built field by field (no `...row`).
- [ ] Your own 4xx messages; no `try/catch` that hides errors.

## 5. Run the tests again (they pass)

```sh
pnpm --filter @pulse/api test:e2e
```

Then try it by hand with the API running (`pnpm --filter @pulse/api dev`):

```sh
curl -i 127.0.0.1:3000/campuses/aiub/summary
```

## 6. Postman

Add a folder for a new feature, or a request in the existing one, under
`postman/collections/Pulse API/`. Copy a request from
[Campuses](../../postman/collections/Pulse%20API/Campuses/) and change:

- `url` (always `{{baseUrl}}/…`), `description`, `order`,
- the `afterResponse` tests (status, exact fields, one value check),
- a saved example in `.resources/<Request>.resources/examples/`, copied from a real response.

Add one request for each error case you test (404, 400). Then:

```sh
pnpm api:postman      # every request passes
```

## 7. README

Add a row to the endpoint table in [README.md](../../README.md#api).

## 8. All checks

```sh
pnpm format && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```

## 9. Commit and PR

One commit per logical step, for example:

```sh
git add packages/contracts
git commit -m "feat(contracts): add the campus summary schema"
git add apps/api README.md postman
git commit -m "feat(api): add campus summary endpoint"
git push -u origin feat/campus-summary
```

Then open the PR as in [Git and pull requests](06-git-and-prs.md).

## Your first tasks: where each one differs from the example

| Task                                           | New in it                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /campuses/lookup?email=`                  | `@Query` + `z.email()`; take the part after `@`; a query on the `email_domains` array (Drizzle's `arrayContains`, which `@pulse/db` must re-export first: a one-line change, ask Ashfak); domains can repeat across campuses, so use unique test domains (`` `${run}.test` ``) and agree with Ashfak what two matches mean; declare it above `:slug` |
| `POST /fares/split-preview`                    | `@Post` + `@Body`; no database; call `largestRemainderSplit` from `@pulse/money`; amounts in integer paisa; check the shares add up in a test                                                                                                                                                                                                        |
| `GET /campuses/:slug/distance?lat=&lng=`       | `@Param` and `@Query` together; `z.coerce.number()` with ranges and the empty-value gotcha above; a PostGIS distance in SQL (`ST_Distance` on `geography`), ask Ashfak for the query shape                                                                                                                                                           |
| `course` table + `GET /campuses/:slug/courses` | A schema change and migration (pair with Ashfak); `campus_id` + RLS policy; reads inside `withCampus`                                                                                                                                                                                                                                                |
