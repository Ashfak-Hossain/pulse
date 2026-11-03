import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  fareSplitRequestSchema,
  type FareSplitPreview,
  type FareSplitRequest,
} from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { FareService } from './fare.service.js';

// Public preview only: this neither records a payment nor changes a ledger.
@Controller('fares')
export class FareController {
  constructor(private readonly fares: FareService) {}

  @Post('split-preview')
  @HttpCode(200)
  preview(
    @Body(new ZodValidationPipe(fareSplitRequestSchema)) body: FareSplitRequest,
  ): FareSplitPreview {
    return this.fares.preview(body);
  }
}
