import { Body, Controller, Get, Patch, Put } from '@nestjs/common';
import {
  putPreferencesSchema,
  updateMeSchema,
  type Me,
  type Preferences,
  type PutPreferences,
  type UpdateMe,
} from '@pulse/contracts';
import { CurrentUser } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { MeService } from './me.service.js';

// The signed-in user's own data. Signing in is required (the global guard); the user is always
// the caller, so there is no user id in any path
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

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
}
