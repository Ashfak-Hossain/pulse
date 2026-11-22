import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Me, Preferences, PutPreferences, UpdateMe } from '@pulse/contracts';
import {
  and,
  appUser,
  asc,
  campus,
  eq,
  outboxEvent,
  preference,
  sql,
  type Database,
  type Transaction,
  withCampus,
  zone,
} from '@pulse/db';
import { createEvent, routeFor } from '@pulse/events';
import { cellCenter, toCell } from '@pulse/geo';
import { randomUUID } from 'node:crypto';
import type { SignedInUser } from '../auth/session.service.js';
import { DATABASE } from '../db/db.module.js';

type Caller = Pick<SignedInUser, 'id' | 'campusId'>;

// The caller's own profile and travel preferences. Every query is scoped to the caller's id
// inside their campus, so nobody reads or changes another user's row. Names, phones and the home
// pin are personal data: nothing here logs them
@Injectable()
export class MeService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async me(caller: Caller): Promise<Me> {
    return withCampus(this.db, caller.campusId, (tx) => readMe(tx, caller.id));
  }

  /**
   * Changes profile fields. A pending_profile user becomes active once they have a first name,
   * a last name and a gender. Writes ProfileChanged in the same transaction
   */
  async update(caller: Caller, input: UpdateMe): Promise<Me> {
    return withCampus(this.db, caller.campusId, async (tx) => {
      const [row] = await tx
        .update(appUser)
        .set({
          firstName: input.firstName,
          lastName: input.lastName,
          gender: input.gender,
          department: input.department,
          phoneE164: input.phone,
        })
        .where(eq(appUser.id, caller.id))
        .returning({
          status: appUser.status,
          firstName: appUser.firstName,
          lastName: appUser.lastName,
          gender: appUser.gender,
        });
      if (!row) throw new NotFoundException('User not found');
      // Only the onboarding step: a suspended user never becomes active by editing a profile
      if (row.status === 'pending_profile' && row.firstName && row.lastName && row.gender) {
        await tx.update(appUser).set({ status: 'active' }).where(eq(appUser.id, caller.id));
      }
      await writeProfileChanged(tx, caller);
      return readMe(tx, caller.id);
    });
  }

  async preferences(caller: Caller): Promise<Preferences> {
    return withCampus(this.db, caller.campusId, async (tx) => {
      const found = await readPreferences(tx, caller.id);
      if (!found) throw new NotFoundException('No preferences yet');
      return found;
    });
  }

  /**
   * Saves the whole set. The home pin becomes an H3 cell here and is thrown away: only the cell
   * and the zone containing its centre are stored. Writes ProfileChanged in the same transaction
   */
  async putPreferences(caller: Caller, input: PutPreferences): Promise<Preferences> {
    const homeCell = toCell(input.home);
    const centre = cellCenter(homeCell);
    return withCampus(this.db, caller.campusId, async (tx) => {
      // Lock the user first, as update() does with its UPDATE: two writes of one user then run
      // one after the other, so the last ProfileChanged on the compacted topic is the newest state
      await tx
        .select({ id: appUser.id })
        .from(appUser)
        .where(eq(appUser.id, caller.id))
        .for('update');
      // Zones should not overlap; if they do, the first by name wins, the same every time
      const [home] = await tx
        .select({ id: zone.id })
        .from(zone)
        .where(
          sql`ST_Contains(${zone.area}, ST_SetSRID(ST_MakePoint(${centre.lng}, ${centre.lat}), 4326))`,
        )
        .orderBy(asc(zone.name))
        .limit(1);
      const values = {
        homeCell,
        zoneId: home?.id ?? null,
        genderPref: input.genderPref,
        modes: input.modes,
        maxWaitMin: input.maxWaitMin,
        maxDetourPct: input.maxDetourPct,
        autopilotOn: input.autopilotOn,
        quietStartTime: input.quietHours?.start ?? null,
        quietEndTime: input.quietHours?.end ?? null,
        dailyNotifyBudget: input.dailyNotifyBudget,
        shareTextForTraining: input.shareTextForTraining,
      };
      await tx
        .insert(preference)
        .values({ userId: caller.id, campusId: caller.campusId, ...values })
        .onConflictDoUpdate({ target: preference.userId, set: values });
      await writeProfileChanged(tx, caller);
      const saved = await readPreferences(tx, caller.id);
      if (!saved) throw new Error('preferences vanished after the upsert');
      return saved;
    });
  }
}

async function readMe(tx: Transaction, userId: string): Promise<Me> {
  const [row] = await tx
    .select({
      id: appUser.id,
      email: appUser.email,
      role: appUser.role,
      status: appUser.status,
      campus: { id: campus.id, slug: campus.slug, name: campus.name },
      firstName: appUser.firstName,
      lastName: appUser.lastName,
      gender: appUser.gender,
      department: appUser.department,
      phone: appUser.phoneE164,
    })
    .from(appUser)
    .innerJoin(campus, eq(campus.id, appUser.campusId))
    .where(eq(appUser.id, userId))
    .limit(1);
  if (!row) throw new NotFoundException('User not found');
  return row;
}

async function readPreferences(tx: Transaction, userId: string): Promise<Preferences | undefined> {
  const [row] = await tx
    .select({
      zoneId: zone.id,
      zoneName: zone.name,
      genderPref: preference.genderPref,
      modes: preference.modes,
      maxWaitMin: preference.maxWaitMin,
      maxDetourPct: preference.maxDetourPct,
      autopilotOn: preference.autopilotOn,
      quietStartTime: preference.quietStartTime,
      quietEndTime: preference.quietEndTime,
      dailyNotifyBudget: preference.dailyNotifyBudget,
      shareTextForTraining: preference.shareTextForTraining,
    })
    .from(preference)
    .leftJoin(zone, and(eq(zone.id, preference.zoneId), eq(zone.campusId, preference.campusId)))
    .where(eq(preference.userId, userId))
    .limit(1);
  if (!row) return undefined;
  const { zoneId, zoneName, quietStartTime, quietEndTime, ...rest } = row;
  return {
    ...rest,
    // The contract's enum; the column's CHECK holds the same list
    modes: rest.modes as Preferences['modes'],
    homeZone: zoneId && zoneName ? { id: zoneId, name: zoneName } : null,
    // PostgreSQL answers time as HH:MM:SS; the contract speaks HH:MM
    quietHours:
      quietStartTime && quietEndTime
        ? { start: quietStartTime.slice(0, 5), end: quietEndTime.slice(0, 5) }
        : null,
  };
}

// The full snapshot the compacted profiles topic keeps per user: read back after the change, so
// it is exactly what the database now holds. No names, phones or home pin
async function writeProfileChanged(tx: Transaction, caller: Caller): Promise<void> {
  const [row] = await tx
    .select({
      role: appUser.role,
      status: appUser.status,
      zoneId: preference.zoneId,
      homeCell: preference.homeCell,
      genderPref: preference.genderPref,
      modes: preference.modes,
      autopilotOn: preference.autopilotOn,
    })
    .from(appUser)
    .leftJoin(preference, eq(preference.userId, appUser.id))
    .where(eq(appUser.id, caller.id))
    .limit(1);
  if (!row) throw new NotFoundException('User not found');

  const event = createEvent(
    'ProfileChanged',
    { campusId: caller.campusId, userId: caller.id, ...row },
    { eventId: randomUUID(), occurredAt: new Date() },
  );
  const { topic, key } = routeFor(event);
  // No .returning(): pulse_app cannot read outbox_event
  await tx.insert(outboxEvent).values({
    id: event.eventId,
    aggregate: 'user',
    aggregateId: caller.id,
    type: event.type,
    version: event.version,
    topic,
    key,
    payload: event.payload,
  });
}
