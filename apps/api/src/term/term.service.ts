import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminTerm, CreateTerm } from '@pulse/contracts';
import {
  and,
  DrizzleQueryError,
  eq,
  outboxEvent,
  term,
  withCampus,
  type Database,
} from '@pulse/db';
import { createEvent, routeFor } from '@pulse/events';
import { randomUUID } from 'node:crypto';
import { type AuditActor, writeAudit } from '../common/audit.js';
import { DATABASE } from '../db/db.module.js';

const termColumns = {
  id: term.id,
  name: term.name,
  startsOn: term.startsOn,
  endsOn: term.endsOn,
  status: term.status,
};

// Campus admins create terms (always as drafts) and activate them. Everything runs inside the
// admin's campus, so another campus's term is simply not found
@Injectable()
export class TermService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** A new draft term. Duplicate name in the campus → 409. */
  async create(actor: AuditActor, input: CreateTerm): Promise<AdminTerm> {
    try {
      return await withCampus(this.db, actor.campusId, async (tx) => {
        const [row] = await tx
          .insert(term)
          .values({ campusId: actor.campusId, ...input })
          .returning(termColumns);
        if (!row) throw new Error('insert returned no row');
        await writeAudit(tx, actor, 'term.create', 'term', row.id, { name: row.name });
        return row;
      });
    } catch (error) {
      if (isUniqueViolation(error, 'term_campus_name_unique')) {
        throw new ConflictException('A term with this name already exists');
      }
      throw error;
    }
  }

  /**
   * Makes a draft term the active one. In one transaction: archive the current active term,
   * activate this one, write the audit row and the TermActivated outbox row. Not a draft → 409
   */
  async activate(actor: AuditActor, id: string): Promise<AdminTerm> {
    try {
      return await withCampus(this.db, actor.campusId, async (tx) => {
        // Locked, so two activations of the same term run one after the other
        const [target] = await tx
          .select({ status: term.status })
          .from(term)
          .where(eq(term.id, id))
          .for('update');
        if (!target) throw new NotFoundException('Term not found');
        if (target.status !== 'draft') {
          throw new ConflictException('Only a draft term can be activated');
        }

        const archived = await tx
          .update(term)
          .set({ status: 'archived' })
          .where(eq(term.status, 'active'))
          .returning({ id: term.id });
        const [row] = await tx
          .update(term)
          .set({ status: 'active' })
          .where(and(eq(term.id, id), eq(term.status, 'draft')))
          .returning(termColumns);
        if (!row) throw new Error('update returned no row');

        await writeAudit(tx, actor, 'term.activate', 'term', id, {
          archivedTermIds: archived.map((old) => old.id),
        });
        const event = createEvent(
          'TermActivated',
          {
            campusId: actor.campusId,
            termId: row.id,
            name: row.name,
            startsOn: row.startsOn,
            endsOn: row.endsOn,
          },
          { eventId: randomUUID(), occurredAt: new Date() },
        );
        const { topic, key } = routeFor(event);
        // No .returning(): pulse_app cannot read outbox_event
        await tx.insert(outboxEvent).values({
          id: event.eventId,
          aggregate: 'term',
          aggregateId: row.id,
          type: event.type,
          version: event.version,
          topic,
          key,
          payload: event.payload,
        });
        return row;
      });
    } catch (error) {
      // Two different drafts activated at once: the one-active-term index lets only one win
      if (isUniqueViolation(error, 'term_one_active_per_campus')) {
        throw new ConflictException('Another term was activated at the same time; try again');
      }
      throw error;
    }
  }
}

// 23505 = unique_violation. Matched on the constraint name, so any other duplicate stays a 500
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : undefined;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === '23505' &&
    'constraint' in cause &&
    cause.constraint === constraint
  );
}
