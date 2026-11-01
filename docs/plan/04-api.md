# 04 · API

Every HTTP endpoint and WebSocket message Pulse will have. Request and response schemas live in
`@pulse/contracts` (one file per module) and are shared with `apps/web`.

## 1. Conventions

| Topic         | Rule                                                                                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL      | The browser calls `/api/*` on the web origin; the proxy strips `/api` and forwards to the API. Inside the API, routes have no prefix (as today: `/health`, `/campuses`). Postman uses `{{baseUrl}}`.                                    |
| Format        | JSON, `camelCase` fields, ISO-8601 times with offset, money as integer `…Paisa`, places as `{lat, lng}` or GeoJSON for shapes.                                                                                                          |
| Validation    | Every body, query and param goes through `ZodValidationPipe` with a `.strict()` schema (unknown fields → 400). IDs are UUIDs; slugs are `^[a-z0-9-]{2,40}$`.                                                                            |
| Errors        | The existing shape: `{statusCode, error, message, issues?}`. Add an optional `code` (add-only change to `apiErrorSchema`) for machine-readable domain errors, e.g. `OTP_LOCKED`, `TRIP_NOT_MEMBER`, `IDEMPOTENCY_MISMATCH`, `RUN_FULL`. |
| Auth          | Cookie `pulse_at` (JWT access token, 15 min) on every authenticated route. `AuthGuard` loads the user; `@Roles(...)` checks the role; services check ownership.                                                                         |
| CSRF          | Cookies are `SameSite=Lax`; every state-changing request must also carry an `Origin` header matching `APP_ORIGIN` (checked by a global guard).                                                                                          |
| Pagination    | Cursor based: `?limit=20&cursor=<opaque>` → `{items, nextCursor}`. `limit` ≤ 100. Stable order always ends on a unique column (`id`).                                                                                                   |
| Idempotency   | `POST` routes marked **I** accept an `Idempotency-Key: <uuid>` header; a retry with the same key returns the first response.                                                                                                            |
| Rate limits   | Default 120 requests/min per user. Stricter limits are listed per route.                                                                                                                                                                |
| Personal data | Never in paths or query strings (they reach logs). Use bodies, UUIDs and slugs.                                                                                                                                                         |
| Versioning    | No URL version in v1. Breaking changes need a new route; contracts are add-only like events.                                                                                                                                            |
| Status codes  | 200 read/update, 201 created, 202 accepted (a job will finish it), 204 no body, 400 validation, 401 no/expired session, 403 wrong role or not a member, 404, 409 state conflict, 422 business rule, 429.                                |

**Roles column**: `public` = no session · `any` = any signed-in user · `rider` = student, faculty,
staff (and operators acting as riders) · `member` = must belong to the trip/crew · `operator` ·
`cadmin` = campus admin (platform admins pass too) · `padmin` = platform admin.

**Emits column**: Kafka events written to the outbox in the same transaction ([05](05-events-and-jobs.md)).

## 2. Health (exists)

| Method | Path            | Roles  | Response                                               |
| ------ | --------------- | ------ | ------------------------------------------------------ |
| GET    | `/health`       | public | `{status: 'ok'}` (liveness)                            |
| GET    | `/health/ready` | public | 200 when PostgreSQL (and later Redis) answer, else 503 |

## 3. Auth

| Method | Path                 | Roles  | Body → Response                                                     | Emits                        | Notes                                                                                                                   |
| ------ | -------------------- | ------ | ------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/otp/request`  | public | `{email, turnstileToken?}` → 202 `{expiresInSec: 600}`              |                              | Same 202 whether or not the domain/user exists (no account probing). 5/h per email, 20/h per IP. Queues `notify.email`. |
| POST   | `/auth/otp/verify`   | public | `{email, code}` → 200 `{user, isNew}` + sets `pulse_at`, `pulse_rt` | `UserRegistered` (new users) | 5 wrong codes lock the code (`OTP_LOCKED`). Creates `app_user` on first success.                                        |
| POST   | `/auth/refresh`      | public | cookie `pulse_rt` → 204 + new cookies                               |                              | Rotation; reuse of an old token revokes the whole family and returns 401.                                               |
| POST   | `/auth/sign-out`     | any    | → 204, clears cookies                                               |                              | Revokes this session                                                                                                    |
| POST   | `/auth/sign-out-all` | any    | → 204                                                               |                              | Revokes every session of the user                                                                                       |
| GET    | `/auth/sessions`     | any    | → `{items: [{id, userAgent, createdAt, current}]}`                  |                              |                                                                                                                         |
| DELETE | `/auth/sessions/:id` | any    | → 204                                                               |                              | Own sessions only                                                                                                       |

Cookies: `pulse_at` (httpOnly, Secure, SameSite=Lax, path `/`, 15 min); `pulse_rt` (httpOnly,
Secure, SameSite=Strict, path `/api/auth`, 30 days). The JWT holds `sub`, `campusId`, `role`,
`sid` (session id), signed HS256 with `JWT_SECRET` (rotated via `kid`).

## 4. Campus (public + admin)

| Method | Path                                 | Roles  | Body → Response                                                          | Emits            |
| ------ | ------------------------------------ | ------ | ------------------------------------------------------------------------ | ---------------- |
| GET    | `/campuses`                          | public | → `{items: Campus[]}` (exists; hides `is_simulated`)                     |                  |
| GET    | `/campuses/:slug`                    | public | → `Campus` (exists)                                                      |                  |
| POST   | `/campuses/lookup`                   | public | `{email}` → `{campus: {slug, name} \| null}` (replaces S24's query form) |                  |
| POST   | `/admin/campuses`                    | padmin | `{name, slug, emailDomains, location, timezone, catalogFormat?}` → 201   | `CampusCreated`  |
| PATCH  | `/admin/campuses/:id`                | padmin | partial → 200                                                            | `CampusUpdated`  |
| POST   | `/admin/campuses/:id/admins`         | padmin | `{email}` → 200 (user becomes `campus_admin`; created as pending if new) | `ProfileChanged` |
| GET    | `/gates`                             | any    | → `Gate[]`                                                               |                  |
| POST   | `/admin/gates`                       | cadmin | `{name, location, isPrimary}` → 201                                      |                  |
| PATCH  | `/admin/gates/:id` · DELETE          | cadmin | → 200 / 204                                                              |                  |
| GET    | `/zones`                             | any    | → `Zone[]` (GeoJSON)                                                     |                  |
| POST   | `/admin/zones`                       | cadmin | `{name, area: GeoJSON MultiPolygon}` → 201                               |                  |
| PATCH  | `/admin/zones/:id` · DELETE          | cadmin |                                                                          |                  |
| GET    | `/meeting-points?zoneId=`            | any    | → `MeetingPoint[]`                                                       |                  |
| POST   | `/admin/meeting-points`              | cadmin | `{name, kind, location, zoneId?}` → 201                                  |                  |
| PATCH  | `/admin/meeting-points/:id` · DELETE | cadmin |                                                                          |                  |
| GET    | `/terms` · `/terms/active`           | any    | → `Term[]` / `Term`                                                      |                  |
| POST   | `/admin/terms`                       | cadmin | `{name, startsOn, endsOn}` → 201                                         |                  |
| POST   | `/admin/terms/:id/activate`          | cadmin | → 200 (previous active term archived)                                    | `TermActivated`  |

## 5. Me (profile, preferences, people)

| Method | Path                                                 | Roles  | Body → Response                                                                                                                                                                                                                 | Emits               |
| ------ | ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| GET    | `/me`                                                | any    | → `Me` (profile, role, status, campus, onboarding checklist)                                                                                                                                                                    |                     |
| PATCH  | `/me`                                                | any    | `{firstName?, lastName?, gender?, department?, phone?}` → `Me`; status → `active` when complete                                                                                                                                 | `ProfileChanged`    |
| PUT    | `/me/photo`                                          | any    | `{fileId}` (uploaded via `/files`) → `Me`                                                                                                                                                                                       |                     |
| GET    | `/me/preferences`                                    | any    | → `Preferences`                                                                                                                                                                                                                 |                     |
| PUT    | `/me/preferences`                                    | any    | `{home: {lat,lng}, genderPref, modes, maxWaitMin, maxDetourPct, autopilotOn, quietHours?, dailyNotifyBudget, shareTextForTraining}` → `Preferences`. The server turns the pin into an H3 cell and **discards the exact point**. | `ProfileChanged`    |
| GET    | `/me/vehicles` · POST · PATCH `/:id` · DELETE `/:id` | rider  | `{type, seats, plate, color}`                                                                                                                                                                                                   |                     |
| GET    | `/me/trusted-contacts` · POST · DELETE `/:id`        | rider  | `{name, phone, relation}`; max 3                                                                                                                                                                                                |                     |
| GET    | `/me/reliability`                                    | rider  | → `{score, shows, noShows, lateCount}` (only the user sees it)                                                                                                                                                                  |                     |
| GET    | `/me/savings?termId=`                                | rider  | → `{savedPaisa, sharedTrips, co2Grams, card: {…}}`                                                                                                                                                                              |                     |
| POST   | `/me/exports`                                        | any    | → 202 `{exportId}`                                                                                                                                                                                                              | (job `export.user`) |
| GET    | `/me/exports/:id`                                    | any    | → `{status, downloadUrl?}`                                                                                                                                                                                                      |                     |
| DELETE | `/me`                                                | any    | `{confirm: "DELETE"}` → 202; PII overwritten, sessions revoked, open requests cancelled                                                                                                                                         | `UserDeleted`       |
| GET    | `/users/:id/card`                                    | member | → `{firstName, photoUrl, department, homeZone}`, only if both share an active crew or trip                                                                                                                                      |                     |

## 6. Catalog and routine

| Method | Path                                         | Roles           | Body → Response                                                                                                                                              | Emits             |
| ------ | -------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- |
| POST   | `/admin/catalog/imports`                     | cadmin          | `{fileId, adapter?}` → 202 `{importId}` (job `import.timetable`)                                                                                             |                   |
| GET    | `/admin/catalog/imports` · `/:id`            | cadmin          | → `CatalogImport` with stats and the first 200 errors                                                                                                        |                   |
| POST   | `/admin/catalog/imports/:id/apply`           | cadmin          | → 202; upserts sections by (term, classId); cancelled sections marked                                                                                        | `CatalogImported` |
| GET    | `/sections?termId=&q=&cursor=`               | any             | → `{items: Section[]}`; `q` searches code and title (trigram)                                                                                                |                   |
| GET    | `/sections/:id`                              | any             | → `Section` with meetings                                                                                                                                    |                   |
| POST   | `/me/routine/resolve`                        | rider           | `{termName, classes: [{classId, courseTitle}]}` → `{matched: Section[], unmatched: [{classId, reason}]}`. Read-only. Grades never reach this route (rule 9). |                   |
| PUT    | `/me/routine`                                | rider           | `{termId, sectionIds, source}` → `Routine` (replaces the user's enrollments for the term)                                                                    | `RoutineChanged`  |
| GET    | `/me/routine?termId=`                        | rider           | → `Routine` (sections + meetings)                                                                                                                            |                   |
| GET    | `/me/week?from=YYYY-MM-DD`                   | rider           | → 7 days of classes **with calendar overrides applied**, office hours, and planned trips                                                                     |                   |
| PUT    | `/me/teaching`                               | rider (faculty) | `{termId, sectionIds}` → `Routine` (enrollment role `instructor`)                                                                                            | `RoutineChanged`  |
| GET    | `/me/schedule-blocks` · POST · DELETE `/:id` | rider (staff)   | `{termId, weekday, startTime, endTime, label}`                                                                                                               | `RoutineChanged`  |

## 7. Calendar and class changes

| Method | Path                                                  | Roles  | Body → Response                                                                                                                 | Emits                                                                         |
| ------ | ----------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/calendar?from=&to=`                                 | any    | → campus-wide events + events for my sections                                                                                   |                                                                               |
| POST   | `/admin/calendar-events`                              | cadmin | `{kind, onDate, endDate?, sectionId?, newDate?, newStartTime?, newEndTime?, note}` → 201                                        | `HolidayDeclared` / `ClassCancelled` / `ClassRescheduled` / `ExtraClassAdded` |
| DELETE | `/admin/calendar-events/:id`                          | cadmin | → 204                                                                                                                           | `CalendarEventWithdrawn`                                                      |
| POST   | `/class-change-reports`                               | rider  | `{sectionId, kind, onDate, newDate?, newStartTime?, newEndTime?}` → 201 (`applied` at once if the reporter teaches the section) | class event if applied                                                        |
| POST   | `/class-change-reports/:id/confirm`                   | rider  | → 200 (second enrolled student applies it)                                                                                      | class event if applied                                                        |
| GET    | `/admin/class-change-reports?status=`                 | cadmin | → list                                                                                                                          |                                                                               |
| POST   | `/admin/class-change-reports/:id/approve` · `/reject` | cadmin | → 200                                                                                                                           | class event on approve                                                        |

## 8. Requests, Autopilot, waitlists, forecast

| Method | Path                                           | Roles | Body → Response                                                                                                                                                                | Emits                                  |
| ------ | ---------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| POST   | `/requests/parse`                              | rider | `{text}` (≤ 280) → `{direction?, place?: {name, cell}, windowStart?, windowEnd?, genderPref?, maxWaitMin?, confidence, parser}`. Never stores the text unless consent. 30/min. |                                        |
| POST   | `/requests` **I**                              | rider | `{kind, direction, windowStart, windowEnd, home?, gateId?, modes?, genderPref?, maxWaitMin?, source, parsedFrom?}` → 201 `TripRequest`                                         | `TripRequested`                        |
| GET    | `/requests?status=&cursor=`                    | rider | → own requests                                                                                                                                                                 |                                        |
| GET    | `/requests/:id`                                | rider | → `TripRequest` (+ trip summary if matched)                                                                                                                                    |                                        |
| DELETE | `/requests/:id`                                | rider | → 204 (only `open`)                                                                                                                                                            | `TripRequestCancelled`                 |
| POST   | `/requests/:id/go-solo`                        | rider | → 200 `{bookingLinks}`; status `solo`                                                                                                                                          | `TripRequestCancelled` (reason `solo`) |
| GET    | `/go-now/outlook?direction=`                   | rider | → `{compatibleSoon: {p10, p50, p90}, chanceWithin: [{minutes, p}], advice: 'wait' \| 'go', waitMinutes, expectedSavingPaisa}`                                                  |                                        |
| GET    | `/plans` · POST · PATCH `/:id` · DELETE `/:id` | rider | Recurring plans `{direction, weekday, localTime, flexMin, modes}`                                                                                                              |                                        |
| GET    | `/autopilot/today`                             | rider | → today's `AutopilotSuggestion[]`                                                                                                                                              |                                        |
| POST   | `/autopilot/suggestions/:id/confirm` **I**     | rider | → 201 `TripRequest`                                                                                                                                                            | `TripRequested`                        |
| POST   | `/autopilot/suggestions/:id/skip`              | rider | → 200                                                                                                                                                                          |                                        |
| GET    | `/autopilot/habits`                            | rider | → learned departure offsets per weekday and direction                                                                                                                          |                                        |
| GET    | `/waitlists/mine`                              | rider | → `[{id, zone, direction, timeSlot, members, needed, unlocked}]`                                                                                                               |                                        |
| POST   | `/waitlists`                                   | rider | `{direction, timeSlot, weekdays}` (zone from preferences) → 201                                                                                                                | `WaitlistUnlocked` when the 3rd joins  |
| DELETE | `/waitlists/:id`                               | rider | → 204                                                                                                                                                                          |                                        |
| GET    | `/waitlists/:id/invite`                        | rider | → `{url}` (signed invite link to the sign-up page)                                                                                                                             |                                        |

## 9. Crews and trips

| Method | Path                                 | Roles                     | Body → Response                                                                                                         | Emits                                             |
| ------ | ------------------------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| GET    | `/trips?when=upcoming\|past&cursor=` | rider                     | → own trips                                                                                                             |                                                   |
| GET    | `/trips/:id`                         | member                    | → crew card: members (cards), roles, why matched, vehicle, meeting point, booker, share % per member, status, deadlines |                                                   |
| POST   | `/trips/:id/confirm`                 | member                    | → 200                                                                                                                   | `MemberConfirmed` (+ `TripConfirmed` when enough) |
| POST   | `/trips/:id/decline`                 | member                    | `{reason?}` → 200 (standby promoted if any)                                                                             | `MemberDeclined`, maybe `MemberReplaced`          |
| POST   | `/trips/:id/leave`                   | member                    | → 200 (after confirming; counts toward reliability if late)                                                             | `MemberLeft`                                      |
| POST   | `/trips/:id/running-late`            | member                    | `{minutes: 2..20}` → 200                                                                                                | `MemberRunningLate`                               |
| POST   | `/trips/:id/board`                   | member                    | → 200 (at the meeting point)                                                                                            | `MemberBoarded`                                   |
| POST   | `/trips/:id/start`                   | member (booker or driver) | → 200                                                                                                                   | `TripStarted`                                     |
| POST   | `/trips/:id/arrive`                  | member (booker or driver) | → 200                                                                                                                   | `TripArrived`                                     |
| POST   | `/trips/:id/safe-arrival`            | member                    | → 200                                                                                                                   | `SafeArrivalConfirmed`                            |
| GET    | `/trips/:id/booking-links`           | member                    | → `{uber: url, pathao: {appUrl, copyText}}`                                                                             |                                                   |
| GET    | `/trips/:id/messages?cursor=`        | member                    | → `{items: Message[]}` newest first                                                                                     |                                                   |
| POST   | `/trips/:id/messages` **I**          | member                    | `{body}` → 201 (also pushed over WebSocket). 20/min.                                                                    | `MessagePosted`                                   |
| GET    | `/crews/:id`                         | member                    | → crew with members and recent trips                                                                                    |                                                   |

## 10. Safety

| Method | Path                                      | Roles  | Body → Response                                                           | Emits                                              |
| ------ | ----------------------------------------- | ------ | ------------------------------------------------------------------------- | -------------------------------------------------- |
| POST   | `/trips/:id/sos` **I**                    | member | `{location: {lat,lng}, note?}` → 201                                      | `SosRaised`                                        |
| POST   | `/safety-checks/:id/ok`                   | member | → 200 (resolves the check)                                                | `SafetyResolved`                                   |
| POST   | `/trips/:id/ratings`                      | member | `{ratings: [{subjectId, score, tags}]}` → 201 (within 72 h of the trip)   | `RatingSubmitted`                                  |
| POST   | `/reports`                                | rider  | `{subjectId, tripId?, category, description}` → 201                       | `UserReported`                                     |
| GET    | `/me/reports`                             | rider  | → own reports and their status                                            |                                                    |
| GET    | `/blocks` · POST · DELETE `/:userId`      | rider  | `{userId}`                                                                | `UserBlocked` / `UserUnblocked`                    |
| GET    | `/admin/reports?status=` · `/:id`         | cadmin | → reports with context (trip, previous reports)                           |                                                    |
| PATCH  | `/admin/reports/:id`                      | cadmin | `{status, resolution}` → 200                                              |                                                    |
| POST   | `/admin/users/:id/moderation`             | cadmin | `{action: warn \| suspend \| unsuspend, reason, until?, reportId?}` → 201 | `UserWarned` / `UserSuspended` / `UserUnsuspended` |
| GET    | `/admin/sos?status=`                      | cadmin | → open SOS events                                                         |                                                    |
| POST   | `/admin/sos/:id/acknowledge` · `/resolve` | cadmin | → 200                                                                     | `SosAcknowledged` / `SosResolved`                  |
| GET    | `/admin/sms-inbox?cursor=`                | cadmin | → simulated SMS messages                                                  |                                                    |

## 11. Wallet and ledger

| Method | Path                                   | Roles           | Body → Response                                                                                                   | Emits                                 |
| ------ | -------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| GET    | `/wallet`                              | rider           | → `{totalOwedPaisa, totalOwingPaisa, crews: [{crewId, balancePaisa, members}]}`                                   |                                       |
| GET    | `/wallet/crews/:crewId/ledger?cursor=` | member          | → journal entries with my posting and the split breakdown                                                         |                                       |
| POST   | `/trips/:id/fare` **I**                | member (booker) | `{amountPaisa, receiptFileId?}` → 201 `FareClaim` with Shapley shares                                             | `FareRecorded`                        |
| GET    | `/trips/:id/fare`                      | member          | → `FareClaim` (shares, votes, deadline)                                                                           |                                       |
| POST   | `/fare-claims/:id/confirm`             | member          | → 200 (all confirmed → posted)                                                                                    | `FarePosted` when posted              |
| POST   | `/fare-claims/:id/dispute`             | member          | `{reason}` → 201                                                                                                  | `DisputeRaised`                       |
| POST   | `/fare-claims/:id/withdraw`            | member (booker) | → 200 (only while `pending` or `disputed`)                                                                        |                                       |
| GET    | `/settlements?status=`                 | rider           | → transfers I must pay or receive                                                                                 |                                       |
| POST   | `/settlements/:id/pay` **I**           | rider (payer)   | → 200 `{reference}` (simulated bKash: always succeeds after a 1 s delay; writes the journal entry)                | `SettlementPaid`                      |
| GET    | `/admin/disputes?status=`              | cadmin          | → disputes with the claim, receipt link and votes                                                                 |                                       |
| POST   | `/admin/disputes/:id/resolve`          | cadmin          | `{decision: upheld \| rejected, note, correctedAmountPaisa?}` → 200 (upheld after posting → reversal + new entry) | `DisputeResolved`, maybe `FarePosted` |

## 12. Shuttles

| Method | Path                                            | Roles    | Body → Response                                                              | Emits                                      |
| ------ | ----------------------------------------------- | -------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| GET    | `/shuttle/routes`                               | rider    | → approved routes with stops                                                 |                                            |
| GET    | `/shuttle/runs?routeId=&date=`                  | rider    | → runs with free seats                                                       |                                            |
| POST   | `/shuttle/runs/:id/bookings` **I**              | rider    | `{stopId}` → 201 `{bookingId}` (`RUN_FULL` if none left)                     | `SeatBooked`                               |
| DELETE | `/shuttle/bookings/:id`                         | rider    | → 204 (until 30 min before departure)                                        | `SeatCancelled`                            |
| GET    | `/shuttle/bookings/mine`                        | rider    | → bookings                                                                   |                                            |
| GET    | `/shuttle/bookings/:id/pass`                    | rider    | → `{qrToken, seatNo?, run, stop}`                                            |                                            |
| POST   | `/operator/apply`                               | any      | `{name}` → 201 (status `pending`)                                            |                                            |
| GET    | `/operator/me`                                  | operator | → operator profile and status                                                |                                            |
| GET    | `/operator/vehicles` · POST · PATCH `/:id`      | operator | `{type, seats, plate, driverName}`                                           |                                            |
| GET    | `/operator/routes` · POST                       | operator | `{name, direction, stops: [{name, location, offsetMin}]}` → 201 (`proposed`) |                                            |
| GET    | `/operator/demand?date=&direction=`             | operator | → `demand_snapshot` rows (noisy, suppressed under 3)                         |                                            |
| GET    | `/operator/suggested-runs?date=`                | operator | → suggested `{routeId, departsAt, expectedRiders}` from forecast demand      |                                            |
| POST   | `/operator/runs`                                | operator | `{routeId, vehicleId, departsAt, seatPricePaisa}` → 201                      | `ShuttleRunPublished`                      |
| PATCH  | `/operator/runs/:id`                            | operator | `{departsAt?, seatPricePaisa?, status: cancelled?}` → 200                    | `ShuttleRunCancelled`                      |
| GET    | `/operator/runs/:id/bookings`                   | operator | → bookings (first names, stops, seat numbers)                                |                                            |
| POST   | `/operator/runs/:id/assign-seats`               | operator | → 200 (min-cost flow seat assignment)                                        | `SeatsAssigned`                            |
| POST   | `/operator/runs/:id/check-in`                   | operator | `{qrToken}` → 200 `{firstName, seatNo}`                                      | `RiderCheckedIn`                           |
| POST   | `/operator/runs/:id/depart` · `/arrive`         | operator | → 200                                                                        | `ShuttleRunDeparted` / `ShuttleRunArrived` |
| GET    | `/operator/earnings?from=&to=`                  | operator | → simulated payouts                                                          |                                            |
| GET    | `/admin/operators?status=`                      | cadmin   | → operators                                                                  |                                            |
| POST   | `/admin/operators/:id/approve` · `/suspend`     | cadmin   | → 200                                                                        | `ProfileChanged` (role)                    |
| POST   | `/admin/shuttle-routes/:id/approve` · `/retire` | cadmin   | → 200                                                                        |                                            |

## 13. Notifications and calendar feed

| Method | Path                      | Roles  | Body → Response                                                      |
| ------ | ------------------------- | ------ | -------------------------------------------------------------------- |
| GET    | `/notifications?cursor=`  | any    | → `{items, unreadCount}`                                             |
| POST   | `/notifications/:id/read` | any    | → 204                                                                |
| POST   | `/notifications/read-all` | any    | → 204                                                                |
| GET    | `/push/vapid-public-key`  | any    | → `{key}`                                                            |
| POST   | `/push-subscriptions`     | any    | `{endpoint, keys: {p256dh, auth}}` → 201                             |
| DELETE | `/push-subscriptions/:id` | any    | → 204                                                                |
| POST   | `/calendar-feed`          | rider  | → `{url}` (creates or rotates the token; old URL stops working)      |
| GET    | `/cal/:token.ics`         | public | → `text/calendar` with classes and planned trips (no co-rider names) |

## 14. Files

| Method | Path                | Roles                   | Body → Response                                                                                                            |
| ------ | ------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/files`            | any                     | multipart `{purpose, file}` → 201 `{fileId}`. Type by magic bytes, size by purpose ([03](03-data-model.md) §13.1). 10/min. |
| GET    | `/files/:id/url`    | owner or allowed viewer | → `{url, expiresAt}` (5 min signed link). Receipts: crew members; timetables: campus admins.                               |
| GET    | `/files/raw/:token` | public (signed)         | → the bytes, `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`                                          |

## 15. Admin: AI, playground, analytics, flags, models, audit

| Method | Path                                              | Roles                             | Body → Response                                                                   | Emits                    |
| ------ | ------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- | ------------------------ |
| POST   | `/admin/onboarding/specs`                         | cadmin                            | `{fileId}` (public timetable) → 202 `{specId}` (job `ai.onboarding`)              |                          |
| GET    | `/admin/onboarding/specs` · `/:id`                | cadmin                            | → spec, validation report, sample rows parsed with it                             |                          |
| POST   | `/admin/onboarding/specs/:id/approve` · `/reject` | cadmin                            | → 200 (approve sets `campus.catalog_format = spec:<id>`)                          | `OnboardingSpecApproved` |
| GET    | `/admin/matching/batches?date=&mode=`             | cadmin                            | → batch list with metrics                                                         |                          |
| GET    | `/admin/matching/batches/:id`                     | cadmin                            | → input (anonymised), result groups, explanation, metrics: for the map replay     |                          |
| POST   | `/admin/matching/replay`                          | cadmin                            | `{date, algorithm, params?}` → 202 `{replayId}` (shadow consumer replays the day) |                          |
| GET    | `/admin/matching/compare?baseline=&candidate=`    | cadmin                            | → side-by-side metrics (crews, savings, detours, fairness)                        |                          |
| GET    | `/admin/analytics/summary?from=&to=`              | cadmin                            | → KPIs: users, requests, match rate, trips, savings, forecast accuracy, fairness  |                          |
| GET    | `/admin/analytics/series?metric=&from=&to=`       | cadmin                            | → daily series from `analytics_daily`                                             |                          |
| GET    | `/flags`                                          | any                               | → client-visible flags for my campus                                              |                          |
| GET    | `/admin/flags`                                    | cadmin                            | → all flags with global and campus values                                         |                          |
| PUT    | `/admin/flags/:key`                               | cadmin (campus) / padmin (global) | `{enabled, scope: campus \| global}` → 200                                        |                          |
| GET    | `/admin/models`                                   | padmin                            | → `ml_model` rows with metrics                                                    |                          |
| POST   | `/admin/models/:id/activate`                      | padmin                            | → 200 (API instances reload within 60 s)                                          | `ModelActivated`         |
| GET    | `/admin/audit?cursor=&action=`                    | cadmin                            | → audit log                                                                       |                          |
| GET    | `/admin/users?q=&role=&cursor=`                   | cadmin                            | → users (name, role, status; email shown to admins only)                          |                          |

Every `/admin/*` write also inserts an `audit_log` row in the same transaction.

## 16. Simulator support (non-production only)

| Method | Path                     | Roles                | Body → Response                                                                |
| ------ | ------------------------ | -------------------- | ------------------------------------------------------------------------------ |
| POST   | `/internal/sim/sessions` | `X-Sim-Token` header | `{campusSlug, email}` → sets cookies for a user of a **simulated campus only** |

The module is not even registered unless `SIM_ENABLED=true`, and it refuses campuses where
`is_simulated = false`. Production config validation fails if `SIM_ENABLED=true`.

## 17. WebSocket protocol (Socket.IO)

Namespace `/rt`, path `/rt/socket.io`. The handshake uses the `pulse_at` cookie; an expired
token disconnects with `auth_expired` and the client refreshes, then reconnects.

### Client → server

| Event             | Payload                                        | Rules                                                                                            |
| ----------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `trip:join`       | `{tripId}`                                     | Must be a participant; ack `{ok}`                                                                |
| `trip:leave`      | `{tripId}`                                     |                                                                                                  |
| `location:update` | `{tripId, lat, lng, accuracyM, speedMps?, at}` | Only when the trip is `boarding`, `in_progress` or `safety_check`; ≤ 1 per 3 s; accuracy ≤ 200 m |
| `chat:typing`     | `{tripId}`                                     | ≤ 1 per 2 s; not stored                                                                          |

Chat messages are **sent over REST** (`POST /trips/:id/messages`) so validation, idempotency and
the outbox apply; the socket only delivers them.

### Server → client

| Event                 | Room                            | Payload                                   |
| --------------------- | ------------------------------- | ----------------------------------------- |
| `notification:new`    | `user:{id}`                     | `Notification`                            |
| `request:matched`     | `user:{id}`                     | `{requestId, tripId}`                     |
| `request:expired`     | `user:{id}`                     | `{requestId}`                             |
| `trip:updated`        | `trip:{id}`                     | `{tripId, status, version, participants}` |
| `chat:message`        | `trip:{id}`                     | `Message`                                 |
| `chat:typing`         | `trip:{id}`                     | `{userId}`                                |
| `location:peer`       | `trip:{id}`                     | `{userId, lat, lng, at}`                  |
| `safety:check`        | `user:{id}`                     | `{checkId, tripId, reason, escalateAt}`   |
| `sos:raised`          | `trip:{id}`, `admin:{campusId}` | `{sosId, tripId, firstName}`              |
| `shuttle:run-updated` | `user:{id}`, `operator:{id}`    | `{runId, status}`                         |

## 18. Endpoint count

| Area                           | Endpoints |
| ------------------------------ | --------- |
| Health, auth                   | 9         |
| Campus and geography           | 23        |
| Me                             | 22        |
| Catalog and routine            | 13        |
| Calendar                       | 7         |
| Requests, Autopilot, waitlists | 17        |
| Trips                          | 14        |
| Safety                         | 16        |
| Ledger                         | 11        |
| Shuttles                       | 25        |
| Notifications, files           | 11        |
| Admin AI, analytics, flags     | 17        |
| Simulator                      | 1         |
| **Total**                      | **~186**  |

Each endpoint lands with: its Zod schemas in `@pulse/contracts`, a unit test for the service,
an e2e test (happy path, validation 400, auth 401/403, a business-rule failure), and a request
with a saved example in the Postman collection.
