import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  campusParamsSchema,
  courseQuerySchema,
  type CampusParams,
  type CourseList,
  type CourseQuery,
} from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CourseService } from './course.service.js';
import { Public } from '../auth/auth.guard.js';

// Public: AIUB publishes its course list, and the app shows it before sign-in. Every query
// still runs inside the selected campus scope
@Public()
@Controller('campuses/:slug/courses')
export class CourseController {
  constructor(private readonly courses: CourseService) {}

  @Get()
  list(
    @Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams,
    @Query(new ZodValidationPipe(courseQuerySchema)) query: CourseQuery,
  ): Promise<CourseList> {
    return this.courses.list(params.slug, query);
  }
}
