import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CreateTrustedContact, TrustedContact, TrustedContactList } from '@pulse/contracts';
import {
  and,
  asc,
  DrizzleQueryError,
  eq,
  trustedContact,
  type Database,
  withCampus,
} from '@pulse/db';
import type { SignedInUser } from '../auth/session.service.js';
import { DATABASE } from '../db/db.module.js';

type Caller = Pick<SignedInUser, 'id' | 'campusId'>;

const SLOTS = [1, 2, 3] as const;

const contactColumns = {
  id: trustedContact.id,
  name: trustedContact.name,
  phone: trustedContact.phoneE164,
  relation: trustedContact.relation,
};

// A user's own trusted contacts, at most three. The service picks a free slot; the unique
// (user_id, slot) key makes the database refuse a fourth even when two requests race
@Injectable()
export class TrustedContactService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(caller: Caller): Promise<TrustedContactList> {
    const items = await withCampus(this.db, caller.campusId, (tx) =>
      tx
        .select(contactColumns)
        .from(trustedContact)
        .where(eq(trustedContact.userId, caller.id))
        .orderBy(asc(trustedContact.slot)),
    );
    return { items };
  }

  async create(caller: Caller, input: CreateTrustedContact): Promise<TrustedContact> {
    try {
      return await withCampus(this.db, caller.campusId, async (tx) => {
        const taken = await tx
          .select({ slot: trustedContact.slot })
          .from(trustedContact)
          .where(eq(trustedContact.userId, caller.id));
        const slot = SLOTS.find((free) => !taken.some((row) => row.slot === free));
        if (slot === undefined) throw limitReached();
        const [row] = await tx
          .insert(trustedContact)
          .values({
            campusId: caller.campusId,
            userId: caller.id,
            slot,
            name: input.name,
            phoneE164: input.phone,
            relation: input.relation,
          })
          .returning(contactColumns);
        if (!row) throw new Error('insert returned no row');
        return row;
      });
    } catch (error) {
      // Another request took the same free slot a moment earlier
      if (isUniqueViolation(error, 'trusted_contact_user_slot_unique')) throw limitReached();
      throw error;
    }
  }

  async remove(caller: Caller, id: string): Promise<void> {
    const [row] = await withCampus(this.db, caller.campusId, (tx) =>
      tx
        .delete(trustedContact)
        .where(and(eq(trustedContact.id, id), eq(trustedContact.userId, caller.id)))
        .returning({ id: trustedContact.id }),
    );
    if (!row) throw new NotFoundException('Trusted contact not found');
  }
}

function limitReached(): UnprocessableEntityException {
  return new UnprocessableEntityException({
    message: 'At most three trusted contacts',
    code: 'TRUSTED_CONTACT_LIMIT',
  });
}

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
