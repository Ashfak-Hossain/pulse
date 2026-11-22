import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateGate,
  CreateMeetingPoint,
  CreateZone,
  Gate,
  GateList,
  MeetingPoint,
  MeetingPointList,
  MeetingPointQuery,
  MultiPolygon,
  UpdateGate,
  UpdateMeetingPoint,
  UpdateZone,
  Zone,
  ZoneList,
} from '@pulse/contracts';
import {
  and,
  asc,
  campusGate,
  desc,
  DrizzleQueryError,
  eq,
  meetingPoint,
  sql,
  type SQL,
  type Database,
  type Transaction,
  withCampus,
  zone,
} from '@pulse/db';
import { toCell } from '@pulse/geo';
import { type AuditActor, writeAudit } from '../common/audit.js';
import { DATABASE } from '../db/db.module.js';

// Campuses have a handful of each; the cap only stops a list from ever returning a whole table
const PLACE_LIST_LIMIT = 500;

type Actor = AuditActor;
type Point = { lat: number; lng: number };

// Gates, zones and meeting points of the caller's campus. Every query runs inside withCampus, so
// another campus's id is simply not found (404). Every admin write leaves one audit_log row in
// the same transaction
@Injectable()
export class PlacesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // ── Gates ─────────────────────────────────────────────────────────────────────────────────

  async gates(campusId: string): Promise<GateList> {
    const rows = await withCampus(this.db, campusId, (tx) =>
      tx
        .select(gateColumns)
        .from(campusGate)
        .orderBy(desc(campusGate.isPrimary), asc(campusGate.name))
        .limit(PLACE_LIST_LIMIT),
    );
    return { items: rows.map(toGate) };
  }

  async createGate(actor: Actor, input: CreateGate): Promise<Gate> {
    return this.write(actor, async (tx) => {
      // One primary per campus: the new one takes over in the same transaction
      if (input.isPrimary) await clearPrimaryGate(tx);
      const [row] = await tx
        .insert(campusGate)
        .values({
          campusId: actor.campusId,
          name: input.name,
          location: toXy(input.location),
          cell: toCell(input.location),
          isPrimary: input.isPrimary,
        })
        .returning(gateColumns);
      const gate = toGate(required(row));
      await writeAudit(tx, actor, 'gate.create', 'campus_gate', gate.id, {
        name: gate.name,
        isPrimary: gate.isPrimary,
      });
      return gate;
    });
  }

  async updateGate(actor: Actor, id: string, input: UpdateGate): Promise<Gate> {
    return this.write(actor, async (tx) => {
      const current = await lockGate(tx, id);
      if (input.isPrimary === false && current.isPrimary) {
        throw new ConflictException('Make another gate primary instead');
      }
      if (input.isPrimary && !current.isPrimary) await clearPrimaryGate(tx);
      const [row] = await tx
        .update(campusGate)
        .set({
          name: input.name,
          isPrimary: input.isPrimary,
          ...(input.location && { location: toXy(input.location), cell: toCell(input.location) }),
        })
        .where(eq(campusGate.id, id))
        .returning(gateColumns);
      const gate = toGate(required(row));
      await writeAudit(tx, actor, 'gate.update', 'campus_gate', id, {
        changed: Object.keys(input),
      });
      return gate;
    });
  }

  async deleteGate(actor: Actor, id: string): Promise<void> {
    await this.write(actor, async (tx) => {
      const current = await lockGate(tx, id);
      if (current.isPrimary) {
        throw new ConflictException('The primary gate cannot be deleted');
      }
      await tx.delete(campusGate).where(eq(campusGate.id, id));
      await writeAudit(tx, actor, 'gate.delete', 'campus_gate', id, { name: current.name });
    });
  }

  // ── Zones ─────────────────────────────────────────────────────────────────────────────────

  async zones(campusId: string): Promise<ZoneList> {
    const items = await withCampus(this.db, campusId, (tx) =>
      tx.select(zoneColumns).from(zone).orderBy(asc(zone.name)).limit(PLACE_LIST_LIMIT),
    );
    return { items };
  }

  async createZone(actor: Actor, input: CreateZone): Promise<Zone> {
    return this.write(actor, async (tx) => {
      const [row] = await tx
        .insert(zone)
        .values({ campusId: actor.campusId, name: input.name, area: fromGeoJson(input.area) })
        .returning(zoneColumns);
      const created = required(row);
      await writeAudit(tx, actor, 'zone.create', 'zone', created.id, { name: created.name });
      return created;
    });
  }

  async updateZone(actor: Actor, id: string, input: UpdateZone): Promise<Zone> {
    return this.write(actor, async (tx) => {
      const [row] = await tx
        .update(zone)
        .set({ name: input.name, ...(input.area && { area: fromGeoJson(input.area) }) })
        .where(eq(zone.id, id))
        .returning(zoneColumns);
      if (!row) throw new NotFoundException('Zone not found');
      await writeAudit(tx, actor, 'zone.update', 'zone', id, { changed: Object.keys(input) });
      return row;
    });
  }

  async deleteZone(actor: Actor, id: string): Promise<void> {
    await this.write(
      actor,
      async (tx) => {
        // Hidden points keep their row for future trips but must not pin the zone forever; active
        // points still block the delete through the foreign key (409)
        await tx
          .update(meetingPoint)
          .set({ zoneId: null })
          .where(and(eq(meetingPoint.zoneId, id), eq(meetingPoint.isActive, false)));
        const [row] = await tx.delete(zone).where(eq(zone.id, id)).returning({ name: zone.name });
        if (!row) throw new NotFoundException('Zone not found');
        await writeAudit(tx, actor, 'zone.delete', 'zone', id, { name: row.name });
      },
      true,
    );
  }

  // ── Meeting points ────────────────────────────────────────────────────────────────────────

  async meetingPoints(campusId: string, query: MeetingPointQuery): Promise<MeetingPointList> {
    const rows = await withCampus(this.db, campusId, (tx) =>
      tx
        .select(pointColumns)
        .from(meetingPoint)
        .where(
          and(
            eq(meetingPoint.isActive, true),
            query.zoneId === undefined ? undefined : eq(meetingPoint.zoneId, query.zoneId),
          ),
        )
        .orderBy(asc(meetingPoint.name), asc(meetingPoint.id))
        .limit(PLACE_LIST_LIMIT),
    );
    return { items: rows.map(toMeetingPoint) };
  }

  async createMeetingPoint(actor: Actor, input: CreateMeetingPoint): Promise<MeetingPoint> {
    return this.write(actor, async (tx) => {
      const [row] = await tx
        .insert(meetingPoint)
        .values({
          campusId: actor.campusId,
          zoneId: input.zoneId,
          name: input.name,
          kind: input.kind,
          location: toXy(input.location),
          cell: toCell(input.location),
        })
        .returning(pointColumns);
      const point = toMeetingPoint(required(row));
      await writeAudit(tx, actor, 'meeting_point.create', 'meeting_point', point.id, {
        name: point.name,
        kind: point.kind,
        zoneId: point.zoneId,
      });
      return point;
    });
  }

  async updateMeetingPoint(
    actor: Actor,
    id: string,
    input: UpdateMeetingPoint,
  ): Promise<MeetingPoint> {
    return this.write(actor, async (tx) => {
      const [row] = await tx
        .update(meetingPoint)
        .set({
          name: input.name,
          kind: input.kind,
          zoneId: input.zoneId,
          ...(input.location && { location: toXy(input.location), cell: toCell(input.location) }),
        })
        .where(and(eq(meetingPoint.id, id), eq(meetingPoint.isActive, true)))
        .returning(pointColumns);
      if (!row) throw new NotFoundException('Meeting point not found');
      await writeAudit(tx, actor, 'meeting_point.update', 'meeting_point', id, {
        changed: Object.keys(input),
      });
      return toMeetingPoint(row);
    });
  }

  /** Hides the point instead of deleting it: trips will point at meeting points later. */
  async deleteMeetingPoint(actor: Actor, id: string): Promise<void> {
    await this.write(actor, async (tx) => {
      const [row] = await tx
        .update(meetingPoint)
        .set({ isActive: false })
        .where(and(eq(meetingPoint.id, id), eq(meetingPoint.isActive, true)))
        .returning({ name: meetingPoint.name });
      if (!row) throw new NotFoundException('Meeting point not found');
      await writeAudit(tx, actor, 'meeting_point.delete', 'meeting_point', id, { name: row.name });
    });
  }

  // One transaction in the actor's campus. Database refusals the client can fix become 409 or
  // 422 with fixed text (PostgreSQL's message would echo the input back); anything else is a 500
  // deletesZone: a zone delete and a meeting point write break the same foreign key, from
  // opposite ends, and PostgreSQL reports both on meeting_point
  private async write<T>(
    actor: Actor,
    work: (tx: Transaction) => Promise<T>,
    deletesZone = false,
  ): Promise<T> {
    try {
      return await withCampus(this.db, actor.campusId, work);
    } catch (error) {
      throw toClientError(error, deletesZone);
    }
  }
}

// ── Columns and row mapping ─────────────────────────────────────────────────────────────────

const gateColumns = {
  id: campusGate.id,
  name: campusGate.name,
  location: campusGate.location,
  isPrimary: campusGate.isPrimary,
};

const zoneColumns = {
  id: zone.id,
  name: zone.name,
  // PostgreSQL builds the GeoJSON; the pg driver parses json columns into objects
  area: sql<MultiPolygon>`ST_AsGeoJSON(${zone.area})::json`,
};

const pointColumns = {
  id: meetingPoint.id,
  zoneId: meetingPoint.zoneId,
  name: meetingPoint.name,
  kind: meetingPoint.kind,
  location: meetingPoint.location,
};

type XyRow<T> = Omit<T, 'location'> & { location: { x: number; y: number } };

// PostGIS stores x = longitude, y = latitude
function toXy(location: Point): { x: number; y: number } {
  return { x: location.lng, y: location.lat };
}

function toGate(row: XyRow<Gate>): Gate {
  return { ...row, location: { lat: row.location.y, lng: row.location.x } };
}

function toMeetingPoint(row: XyRow<MeetingPoint>): MeetingPoint {
  return { ...row, location: { lat: row.location.y, lng: row.location.x } };
}

function fromGeoJson(area: MultiPolygon): SQL<string> {
  return sql<string>`ST_SetSRID(ST_GeomFromGeoJSON(${JSON.stringify(area)}), 4326)`;
}

// .returning() of an insert or a locked update always has the row; this narrows the type
function required<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('write returned no row');
  return row;
}

// ── Writes shared by gates, zones and meeting points ────────────────────────────────────────

async function lockGate(tx: Transaction, id: string) {
  const [row] = await tx
    .select({ name: campusGate.name, isPrimary: campusGate.isPrimary })
    .from(campusGate)
    .where(eq(campusGate.id, id))
    .for('update');
  if (!row) throw new NotFoundException('Gate not found');
  return row;
}

async function clearPrimaryGate(tx: Transaction): Promise<void> {
  // RLS keeps this to the transaction's campus
  await tx.update(campusGate).set({ isPrimary: false }).where(eq(campusGate.isPrimary, true));
}

// ── Database errors the client can fix ──────────────────────────────────────────────────────

const conflicts: Record<string, string> = {
  campus_gate_campus_name_unique: 'A gate with this name already exists',
  campus_gate_one_primary_per_campus: 'Another gate became primary at the same time; try again',
  zone_campus_name_unique: 'A zone with this name already exists',
  meeting_point_zone_campus_fk: 'The zone still has meeting points',
  preference_zone_campus_fk: 'The zone is still a home zone of some users',
};

function toClientError(error: unknown, deletesZone: boolean): unknown {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : undefined;
  if (typeof cause !== 'object' || cause === null) return error;
  const code = 'code' in cause ? cause.code : undefined;
  const constraint = 'constraint' in cause ? cause.constraint : undefined;

  if (code === '23514' && constraint === 'zone_area_valid') {
    return new UnprocessableEntityException('The zone area crosses itself');
  }
  // Users' home zones block a zone delete the same way meeting points do
  if (code === '23503' && constraint === 'preference_zone_campus_fk' && deletesZone) {
    return new ConflictException(conflicts[constraint]);
  }
  if (code === '23503' && constraint === 'meeting_point_zone_campus_fk') {
    // A delete would leave points behind; a point write names a zone this campus does not have
    return deletesZone
      ? new ConflictException(conflicts[constraint])
      : new UnprocessableEntityException('Zone not found');
  }
  if (code === '23505' && typeof constraint === 'string' && constraint in conflicts) {
    return new ConflictException(conflicts[constraint]);
  }
  return error;
}
