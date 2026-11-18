import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/** A keyset page position as an opaque token: base64url of its JSON. */
export function encodeCursor(position: object): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/** Reads a token made by encodeCursor back into its position. Anything else → 400. */
export function decodeCursor<T extends z.ZodType>(token: string, schema: T): z.output<T> {
  const bytes = Buffer.from(token, 'base64url');
  // Node's decoder skips characters it does not know; re-encoding catches a token it bent
  if (bytes.toString('base64url') !== token) throw new BadRequestException('Invalid cursor');
  try {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return schema.parse(input);
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
