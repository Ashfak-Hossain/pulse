import { Injectable } from '@nestjs/common';
import type { FareSplitPreview, FareSplitRequest } from '@pulse/contracts';
import { largestRemainderSplit } from '@pulse/money';

@Injectable()
export class FareService {
  preview(input: FareSplitRequest): FareSplitPreview {
    return {
      totalPaisa: input.totalPaisa,
      shares: largestRemainderSplit(input.totalPaisa, input.weights),
    };
  }
}
