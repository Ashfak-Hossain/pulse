import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createTrustedContactSchema,
  createVehicleSchema,
  meItemParamsSchema,
  putPreferencesSchema,
  updateMeSchema,
  updateVehicleSchema,
  type CreateTrustedContact,
  type CreateVehicle,
  type Me,
  type MeItemParams,
  type Preferences,
  type PutPreferences,
  type TrustedContact,
  type TrustedContactList,
  type UpdateMe,
  type UpdateVehicle,
  type Vehicle,
  type VehicleList,
} from '@pulse/contracts';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MeService } from './me.service.js';
import { TrustedContactService } from './trusted-contact.service.js';
import { VehicleService } from './vehicle.service.js';

const itemParams = new ZodValidationPipe(meItemParamsSchema);

// People who ride: everyone but shuttle operators, who run vehicles of their own company
const RIDERS = ['student', 'faculty', 'staff', 'campus_admin'] as const;

// The signed-in user's own data. Signing in is required (the global guard); the user is always
// the caller, so there is no user id in any path
@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly vehicles: VehicleService,
    private readonly contacts: TrustedContactService,
  ) {}

  @Get()
  get(@CurrentUser() user: SignedInUser): Promise<Me> {
    return this.me.me(user);
  }

  @Patch()
  update(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(updateMeSchema)) body: UpdateMe,
  ): Promise<Me> {
    return this.me.update(user, body);
  }

  @Get('preferences')
  preferences(@CurrentUser() user: SignedInUser): Promise<Preferences> {
    return this.me.preferences(user);
  }

  @Put('preferences')
  putPreferences(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(putPreferencesSchema)) body: PutPreferences,
  ): Promise<Preferences> {
    return this.me.putPreferences(user, body);
  }

  @Roles(...RIDERS)
  @Get('vehicles')
  listVehicles(@CurrentUser() user: SignedInUser): Promise<VehicleList> {
    return this.vehicles.list(user);
  }

  @Roles(...RIDERS)
  @Post('vehicles')
  createVehicle(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createVehicleSchema)) body: CreateVehicle,
  ): Promise<Vehicle> {
    return this.vehicles.create(user, body);
  }

  // Only the caller's own active vehicle; anyone else's id is not found
  @Roles(...RIDERS)
  @Get('vehicles/:id')
  getVehicle(
    @CurrentUser() user: SignedInUser,
    @Param(itemParams) { id }: MeItemParams,
  ): Promise<Vehicle> {
    return this.vehicles.get(user, id);
  }

  @Roles(...RIDERS)
  @Patch('vehicles/:id')
  updateVehicle(
    @CurrentUser() user: SignedInUser,
    @Param(itemParams) { id }: MeItemParams,
    @Body(new ZodValidationPipe(updateVehicleSchema)) body: UpdateVehicle,
  ): Promise<Vehicle> {
    return this.vehicles.update(user, id, body);
  }

  @Roles(...RIDERS)
  @Delete('vehicles/:id')
  @HttpCode(204)
  deleteVehicle(
    @CurrentUser() user: SignedInUser,
    @Param(itemParams) { id }: MeItemParams,
  ): Promise<void> {
    return this.vehicles.remove(user, id);
  }

  @Roles(...RIDERS)
  @Get('trusted-contacts')
  listContacts(@CurrentUser() user: SignedInUser): Promise<TrustedContactList> {
    return this.contacts.list(user);
  }

  @Roles(...RIDERS)
  @Post('trusted-contacts')
  createContact(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createTrustedContactSchema)) body: CreateTrustedContact,
  ): Promise<TrustedContact> {
    return this.contacts.create(user, body);
  }

  @Roles(...RIDERS)
  @Delete('trusted-contacts/:id')
  @HttpCode(204)
  deleteContact(
    @CurrentUser() user: SignedInUser,
    @Param(itemParams) { id }: MeItemParams,
  ): Promise<void> {
    return this.contacts.remove(user, id);
  }
}
