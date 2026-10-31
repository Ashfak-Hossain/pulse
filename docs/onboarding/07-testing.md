# 7. Testing

A test is a small program that runs your code and checks the answer. Tests let you change code
without fear: if you break something, a test goes red before a user notices. Every change ships
with tests (it is a rule), and CI runs all of them on every pull request.

## Three kinds of test

| Kind        | What it checks                                     | Where                                                            | Speed                    | Needs Docker |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ | ------------ |
| **Unit**    | One function or class on its own                   | next to the code: `src/**/*.spec.ts`; packages: `test/*.test.ts` | milliseconds             | No           |
| **e2e**     | The whole API over real HTTP, with a real database | `apps/api/test/*.e2e-spec.ts`                                    | ~1 min (container start) | Yes          |
| **Postman** | The running API, by hand or from the terminal      | `postman/collections/Pulse API/`                                 | seconds                  | API running  |

Which one for what:

- A schema in `contracts` → **unit** tests (valid input passes, each kind of bad input fails).
- Pure logic with no database (a calculation, a mapping) → **unit**.
- An endpoint → **e2e**: status code, body shape (parse it with the contract), 404 and 400 cases.
- Then a **Postman** request for each case, so anyone can try the endpoint by hand.

We use [Vitest](https://vitest.dev) for unit and e2e tests and
[supertest](https://github.com/ladjs/supertest) to call the API in e2e tests.

## Running tests

```sh
pnpm test                                    # every unit test in the repo
pnpm test:e2e                                # every e2e test
pnpm --filter @pulse/api test                # unit tests of the API only
pnpm --filter @pulse/contracts test          # unit tests of contracts only

# one file
pnpm --filter @pulse/api exec vitest run src/common/zod-validation.pipe.spec.ts
pnpm --filter @pulse/api exec vitest run --config vitest.config.e2e.ts test/campuses.e2e-spec.ts

# re-run on every save while you work
pnpm --filter @pulse/contracts exec vitest
```

## How a test reads

```ts
describe('campusSlugSchema', () => {
  // a group, named after what it tests
  it('rejects uppercase', () => {
    // one behaviour, in plain words
    const result = campusSlugSchema.safeParse('AIUB'); // run the code
    expect(result.success).toBe(false); // check the answer
  });
});
```

`it.each([...])` runs the same test for each value in the list: handy for "these five inputs all
fail".

An e2e test calls the API:

```ts
const res = await request(app.getHttpServer()).get('/campuses/nowhere').expect(404);
expect(apiErrorSchema.parse(res.body)).toEqual({
  statusCode: 404,
  error: 'Not Found',
  message: 'Campus not found',
});
```

`apiErrorSchema.parse` fails the test if the body has an extra field or a missing one, so the
test checks the contract, not just the status.

## Write the test first

1. Write the test for the behaviour you want.
2. Run it and watch it **fail for the right reason** ("expected 200, got 404" because the route
   does not exist yet, not "cannot find module" because of a typo).
3. Write the code until it passes.

A test you never saw fail might not be testing anything.

## Reading a failure

```
 FAIL  test/campuses.e2e-spec.ts > Campuses over HTTP, against a real database > an unknown slug answers 404 in the error shape
AssertionError: expected { statusCode: 404, …(2) } to deeply equal { statusCode: 404, …(2) }

- Expected
+ Received

  {
    "error": "Not Found",
-   "message": "Campus not found",
+   "message": "Cannot GET /campuses/nowhere",
    "statusCode": 404,
  }
```

- The first line says **which test** (file > group > test name).
- `- Expected` is what the test wanted, `+ Received` is what the code did.
- Here the message says `Cannot GET`: Nest found no route, so the controller method is missing or
  its decorator is wrong. The code is wrong, not the test.

## Rules for tests

- Never weaken or delete a test to make it pass. Fix the code, or ask.
- One behaviour per `it`, named so a failure explains itself.
- e2e test files share one database and run at the same time: create your own rows with unique
  values (``slug: `aiub-${run}` ``, ``emailDomains: [`${run}.test`]``) and only check your own rows.
- Use made-up data. Never real names, emails or phone numbers.
- Logic that does maths (money splits) also gets a **property test** with
  [fast-check](https://fast-check.dev): "for any total and any number of riders, the shares add up
  to the total". See [packages/money/test/split.test.ts](../../packages/money/test/split.test.ts).
