import { Controller, Get, Param } from '@nestjs/common';
import { campusParamsSchema, type CampusParams, type CourseList } from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CourseService } from './course.service.js';

// Public catalog facts only. Every query still runs inside the selected campus scope.
@Controller('campuses/:slug/courses')
export class CourseController {
  constructor(private readonly courses: CourseService) {}

  @Get()
  list(
    @Param(new ZodValidationPipe(campusParamsSchema)) params: CampusParams,
  ): Promise<CourseList> {
    return this.courses.list(params.slug);
  }
}
