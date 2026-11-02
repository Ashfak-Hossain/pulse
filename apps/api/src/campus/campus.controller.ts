import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  campusDistanceQuerySchema,
  type CampusDistanceQuery,
  type CampusDistance,
  type Campus,
  type CampusList,
  type CampusParams,
  campusParamsSchema,
} from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampusService } from './campus.service.js';

// HTTP only: validate the request, call the service, return its answer.
// Public (no sign-in): the app needs campus facts before anyone has signed in
@Controller('campuses')
export class CampusController {
  constructor(private readonly campuses: CampusService) {}

  @Get()
  list(): Promise<CampusList> {
    return this.campuses.list();
  }

  @Get(':slug/distance')
  distance(
    @Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams,
    @Query(new ZodValidationPipe(campusDistanceQuerySchema)) query: CampusDistanceQuery,
  ): Promise<CampusDistance> {
    return this.campuses.distance(params.slug, query.lat, query.lng);
  }

  // The pipe answers 400 for a malformed slug before the database is asked
  @Get(':slug')
  get(@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams): Promise<Campus> {
    return this.campuses.getBySlug(params.slug);
  }
}
