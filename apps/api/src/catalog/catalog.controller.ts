import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  campusParamsSchema,
  sectionQuerySchema,
  type CampusParams,
  type SectionQuery,
  type SectionList,
  type TermList,
} from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CatalogService } from './catalog.service.js';

@Controller('campuses/:slug')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('terms')
  terms(@Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams): Promise<TermList> {
    return this.catalog.terms(params.slug);
  }

  @Get('sections')
  sections(
    @Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams,
    @Query(new ZodValidationPipe(sectionQuerySchema)) query: SectionQuery,
  ): Promise<SectionList> {
    return this.catalog.sections(params.slug, query);
  }
}
