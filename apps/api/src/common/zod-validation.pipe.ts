import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { type z } from 'zod';

// Validates one part of a request (body, query or params) against a Zod schema from @pulse/contracts.
// Returns the parsed value, so controllers get defaults and coerced types, never the raw input.
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }

    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
}
