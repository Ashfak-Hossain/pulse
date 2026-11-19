import { Controller, Get, Query } from '@nestjs/common';
import {
  meetingPointQuerySchema,
  type GateList,
  type MeetingPointList,
  type MeetingPointQuery,
  type ZoneList,
} from '@pulse/contracts';
import { CurrentUser } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { PlacesService } from './places.service.js';

// Any signed-in user reads the places of their own campus; the campus comes from the session
@Controller()
export class PlacesController {
  constructor(private readonly places: PlacesService) {}

  @Get('gates')
  gates(@CurrentUser() user: SignedInUser): Promise<GateList> {
    return this.places.gates(user.campusId);
  }

  @Get('zones')
  zones(@CurrentUser() user: SignedInUser): Promise<ZoneList> {
    return this.places.zones(user.campusId);
  }

  // Active points only; ?zoneId= narrows to one zone
  @Get('meeting-points')
  meetingPoints(
    @CurrentUser() user: SignedInUser,
    @Query(new ZodValidationPipe(meetingPointQuerySchema)) query: MeetingPointQuery,
  ): Promise<MeetingPointList> {
    return this.places.meetingPoints(user.campusId, query);
  }
}
