import { auditLog, type Transaction } from '@pulse/db';
import type { SignedInUser } from '../auth/session.service.js';

/** Who did an admin write: their id is the actor, and the row goes to their campus. */
export type AuditActor = Pick<SignedInUser, 'id' | 'campusId'>;

/**
 * Records one admin write in audit_log. Call it inside the transaction that makes the change, so
 * the row exists exactly when the change does. Metadata holds ids and non-personal values only
 */
export async function writeAudit(
  tx: Transaction,
  actor: AuditActor,
  action: string,
  entity: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({
    campusId: actor.campusId,
    actorId: actor.id,
    action,
    entity,
    entityId,
    metadata,
  });
}
