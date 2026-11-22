import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  meetingPointQuerySchema,
  placeParamsSchema,
  type Gate,
  type GateList,
  type MeetingPoint,
  type MeetingPointList,
  type MeetingPointQuery,
  type PlaceParams,
  type Zone,
  type ZoneList,
} from '@pulse/contracts';
import { CurrentUser } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlacesService } from './places.service.js';

const params = new ZodValidationPipe(placeParamsSchema);

// Any signed-in user reads the places of their own campus; the campus comes from the session
@Controller()
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('gates')
  gates(@CurrentUser() user: SignedInUser): Promise<GateList> {
    return this.places.gates(user.campusId);
  }

  @Get('gates/:id')
  gate(@CurrentUser() user: SignedInUser, @Param(params) { id }: PlaceParams): Promise<Gate> {
    return this.places.gate(user.campusId, id);
  }

  @Get('zones')
  zones(@CurrentUser() user: SignedInUser): Promise<ZoneList> {
    return this.places.zones(user.campusId);
  }

  @Get('zones/:id')
  zone(@CurrentUser() user: SignedInUser, @Param(params) { id }: PlaceParams): Promise<Zone> {
    return this.places.zone(user.campusId, id);
  }

  // Active points only; ?zoneId= narrows to one zone
  @Get('meeting-points')
  meetingPoints(
    @CurrentUser() user: SignedInUser,
    @Query(new ZodValidationPipe(meetingPointQuerySchema)) query: MeetingPointQuery,
  ): Promise<MeetingPointList> {
    return this.places.meetingPoints(user.campusId, query);
  }

  @Get('meeting-points/:id')
  meetingPoint(
    @CurrentUser() user: SignedInUser,
    @Param(params) { id }: PlaceParams,
  ): Promise<MeetingPoint> {
    return this.places.meetingPoint(user.campusId, id);
  }
}
