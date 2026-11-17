import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { type Campus, type CreateCampus, createCampusSchema } from '@pulse/contracts';
import { AdminTokenGuard } from '../common/admin-token.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { CampusService } from './campus.service.js';
import { Public } from '../auth/auth.guard.js';

// Platform-admin campus writes. The guard runs before the pipe, so a caller without the token
// learns nothing about the body rules
// No session: the admin token guards these until a platform_admin role exists
@Public()
@Controller('admin/campuses')
@UseGuards(AdminTokenGuard)
export class AdminCampusController {
  constructor(private readonly campuses: CampusService) {}

  @Post()
  create(@Body(new ZodValidationPipe(createCampusSchema)) body: CreateCampus): Promise<Campus> {
    return this.campuses.create(body);
  }
}
