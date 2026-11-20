import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  createTermSchema,
  termParamsSchema,
  type AdminTerm,
  type CreateTerm,
  type TermParams,
} from '@pulse/contracts';
import { CurrentUser, Roles } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { TermService } from './term.service.js';

// Campus admins create and activate the terms of their own campus. Students read terms through
// the public /campuses/:slug/terms
@Roles('campus_admin')
@Controller('admin/terms')
export class AdminTermController {
  constructor(private readonly terms: TermService) {}

  @Post()
  create(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(createTermSchema)) body: CreateTerm,
  ): Promise<AdminTerm> {
    return this.terms.create(user, body);
  }

  // 200, not 201: nothing new is created, an existing term changes state
  @Post(':id/activate')
  @HttpCode(200)
  activate(
    @CurrentUser() user: SignedInUser,
    @Param(new ZodValidationPipe(termParamsSchema)) params: TermParams,
  ): Promise<AdminTerm> {
    return this.terms.activate(user, params.id);
  }
}
