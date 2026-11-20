import { Body, Controller, Delete, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createGateSchema,
  createMeetingPointSchema,
  createZoneSchema,
  placeParamsSchema,
  updateGateSchema,
  updateMeetingPointSchema,
  updateZoneSchema,
  type CreateGate,
  type CreateMeetingPoint,
  type CreateZone,
  type Gate,
  type MeetingPoint,
  type PlaceParams,
  type UpdateGate,
  type UpdateMeetingPoint,
  type UpdateZone,
  type Zone,
} from '@pulse/contracts';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlacesService } from './places.service.js';

const params = new ZodValidationPipe(placeParamsSchema);

// Campus admins manage the places of their own campus. The guard runs before the pipes, so a
// student gets 403 without learning the body rules
@Roles('campus_admin')
@Controller('admin')
export class AdminPlacesController {
  constructor(private readonly places: PlacesService) {}

  @Post('gates')
  createGate(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createGateSchema)) body: CreateGate,
  ): Promise<Gate> {
    return this.places.createGate(user, body);
  }

  @Patch('gates/:id')
  updateGate(
    @CurrentUser() user: SignedInUser,
    @Param(params) { id }: PlaceParams,
    @Body(new ZodValidationPipe(updateGateSchema)) body: UpdateGate,
  ): Promise<Gate> {
    return this.places.updateGate(user, id, body);
  }

  @Delete('gates/:id')
  @HttpCode(204)
  deleteGate(@CurrentUser() user: SignedInUser, @Param(params) { id }: PlaceParams): Promise<void> {
    return this.places.deleteGate(user, id);
  }

  @Post('zones')
  createZone(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createZoneSchema)) body: CreateZone,
  ): Promise<Zone> {
    return this.places.createZone(user, body);
  }

  @Patch('zones/:id')
  updateZone(
    @CurrentUser() user: SignedInUser,
    @Param(params) { id }: PlaceParams,
    @Body(new ZodValidationPipe(updateZoneSchema)) body: UpdateZone,
  ): Promise<Zone> {
    return this.places.updateZone(user, id, body);
  }

  @Delete('zones/:id')
  @HttpCode(204)
  deleteZone(@CurrentUser() user: SignedInUser, @Param(params) { id }: PlaceParams): Promise<void> {
    return this.places.deleteZone(user, id);
  }

  @Post('meeting-points')
  createMeetingPoint(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createMeetingPointSchema)) body: CreateMeetingPoint,
  ): Promise<MeetingPoint> {
    return this.places.createMeetingPoint(user, body);
  }

  @Patch('meeting-points/:id')
  updateMeetingPoint(
    @CurrentUser() user: SignedInUser,
    @Param(params) { id }: PlaceParams,
    @Body(new ZodValidationPipe(updateMeetingPointSchema)) body: UpdateMeetingPoint,
  ): Promise<MeetingPoint> {
    return this.places.updateMeetingPoint(user, id, body);
  }

  // Hides the point (is_active = false); trips will point at meeting points later
  @Delete('meeting-points/:id')
  @HttpCode(204)
  deleteMeetingPoint(
    @CurrentUser() user: SignedInUser,
    @Param(params) { id }: PlaceParams,
  ): Promise<void> {
    return this.places.deleteMeetingPoint(user, id);
  }
}
