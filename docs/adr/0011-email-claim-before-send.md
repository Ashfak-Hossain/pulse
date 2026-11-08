# 0011 — Email worker: claim the dedupe key before sending, retry through wait queues

Status: proposed
Date: 2026-11-09

## Context

`notify.email` jobs arrive at least once (ADR 0009): a crash between the confirm and `COMMIT`, or
a timed-out confirm, queues the same job again with the same `jobId` and `dedupeKey`. The queue's
prefetch is 10, so two copies can run at the same moment, and a check-then-send would let both
send. A failed send must still be retried, so "seen this key" cannot simply mean "drop it".
SMTP has no transactions: once the server accepts a message, nothing can take it back.

RabbitMQ 4 never counts a `nack` with requeue toward `x-delivery-limit`, so a handler that
requeues a failing job loops it forever.

## Decision

Claim → send → mark, on a new table `email_delivery` (one row per `dedupe_key`):

1. One statement: insert `status = sending` with a new `claim_id`; on conflict take the row over
   only if it is `failed`, or `sending` with a claim older than 55 s. A row back means this copy
   owns the email.
2. No row back: `sent` → ack the copy as a duplicate; `sending` → fail this copy (it retries).
3. Send with no transaction open (SMTP timeouts 10/10/30 s, each below the lease).
4. Mark `sent` (or `failed` with an SMTP code, never an address) only where `claim_id` is ours.

The job consumer acks a job only once it is done, or once its retry copy is confirmed in a wait
queue (`jobs.retry`, the original routing key, fresh `pulse-*` headers, no `expiration`). It never
requeues. Invalid jobs, unreadable failure counts, SMTP 5xx and the 4th failure are nacked
without requeue (to `jobs.dead`). A refused retry copy is dead-lettered; an unconfirmed one closes
the channel so the original returns; a dropped channel needs nothing. `email_delivery` is a
platform table like `processed_event`: no `campus_id`, no RLS, and only `pulse_mailer` can reach
it (it also reads `campus (id, name)` for templates).

## Alternatives

| Option                                           | Why not                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Check for a `sent` row, then send                | Two copies at once both see nothing and both send.                                                                        |
| Hold a transaction (or row lock) during the send | A transaction open for up to 30 s per email, 10 at a time; a hung server holds connections and locks.                     |
| Insert a plain unique row and drop on conflict   | A copy after a failed send is dropped too, so a temporary SMTP error loses the email.                                     |
| Wait for S51's `notification` table              | It needs `app_user` (S28); system emails such as campus-created have no user. That table can take over user emails later. |
| `nack` with requeue for a failure                | Never reaches `x-delivery-limit` on RabbitMQ 4: the job loops forever with no wait between tries.                         |

## Consequences

- Each email goes out once, except one case: a crash after the server accepted the message and
  before the mark. The claim expires and the retry sends it again. Rare, and acceptable.
- A copy that finds another holding the claim uses one of its retries; if the holder crashed, its
  lease (55 s) ends before the 1 min tier, so the email still goes out.
- `email_delivery` grows by one row per email, and the mailer cannot delete. The owner prunes old
  `sent` rows in the retention purge job when it lands (with an index on `sent_at` then).
- A send slower than the lease (each SMTP step has its own timeout) can be taken over and sent
  twice. The late copy cannot mark the row and logs `sent-unmarked`, so it is visible. A failed
  `sent` mark is logged the same way and the job still counts as done.
- SMTP 5xx is final except a refused login (`EAUTH`), which a config fix makes work on retry.
- Migration 0013 is the one that mixes generated and hand-written SQL: the generated policy for
  `pulse_mailer` needs the hand-written role check to run first.
- The email worker gets its own role, init script, grants and `MAILER_DATABASE_URL` (ADR 0009 pattern).
- Until admin users exist (S29), campus-created goes to `OPS_MAIL_TO`.
