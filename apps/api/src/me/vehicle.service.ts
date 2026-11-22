import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CreateVehicle, UpdateVehicle, Vehicle, VehicleList } from '@pulse/contracts';
import { and, asc, DrizzleQueryError, eq, vehicle, type Database, withCampus } from '@pulse/db';
import type { SignedInUser } from '../auth/session.service.js';
import { DATABASE } from '../db/db.module.js';

type Caller = Pick<SignedInUser, 'id' | 'campusId'>;

const vehicleColumns = {
  id: vehicle.id,
  type: vehicle.type,
  seats: vehicle.seats,
  plate: vehicle.plate,
  color: vehicle.color,
};

// A user's own cars and bikes. Every query filters on owner_id, so another user's vehicle is
// simply not found (404, not 403: ids cannot be probed). Deleting hides the vehicle instead,
// because trips will point at vehicles later
@Injectable()
export class VehicleService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(caller: Caller): Promise<VehicleList> {
    const items = await withCampus(this.db, caller.campusId, (tx) =>
      tx
        .select(vehicleColumns)
        .from(vehicle)
        .where(and(eq(vehicle.ownerId, caller.id), eq(vehicle.isActive, true)))
        .orderBy(asc(vehicle.createdAt), asc(vehicle.id)),
    );
    return { items };
  }

  async get(caller: Caller, id: string): Promise<Vehicle> {
    const [row] = await withCampus(this.db, caller.campusId, (tx) =>
      tx.select(vehicleColumns).from(vehicle).where(owned(caller, id)),
    );
    if (!row) throw new NotFoundException('Vehicle not found');
    return row;
  }

  async create(caller: Caller, input: CreateVehicle): Promise<Vehicle> {
    const [row] = await withCampus(this.db, caller.campusId, (tx) =>
      tx
        .insert(vehicle)
        .values({ campusId: caller.campusId, ownerId: caller.id, ...input })
        .returning(vehicleColumns),
    );
    if (!row) throw new Error('insert returned no row');
    return row;
  }

  async update(caller: Caller, id: string, input: UpdateVehicle): Promise<Vehicle> {
    try {
      const [row] = await withCampus(this.db, caller.campusId, (tx) =>
        tx.update(vehicle).set(input).where(owned(caller, id)).returning(vehicleColumns),
      );
      if (!row) throw new NotFoundException('Vehicle not found');
      return row;
    } catch (error) {
      // A new type or seat count that clashes with the stored one (bike with 3 seats)
      if (isCheckViolation(error, 'vehicle_seats_fit_type')) {
        throw new UnprocessableEntityException('A car has 1 to 6 free seats, a bike exactly 1');
      }
      throw error;
    }
  }

  async remove(caller: Caller, id: string): Promise<void> {
    const [row] = await withCampus(this.db, caller.campusId, (tx) =>
      tx
        .update(vehicle)
        .set({ isActive: false })
        .where(owned(caller, id))
        .returning({ id: vehicle.id }),
    );
    if (!row) throw new NotFoundException('Vehicle not found');
  }
}

function owned(caller: Caller, id: string) {
  return and(eq(vehicle.id, id), eq(vehicle.ownerId, caller.id), eq(vehicle.isActive, true));
}

function isCheckViolation(error: unknown, constraint: string): boolean {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : undefined;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === '23514' &&
    'constraint' in cause &&
    cause.constraint === constraint
  );
}
