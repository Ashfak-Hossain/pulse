import { z } from 'zod';

// Whole paisa only; previews are capped at one lakh taka and eight riders.
const paisaSchema = z.int().min(0).max(10_000_000);
export const fareSplitRequestSchema = z.strictObject({
  totalPaisa: paisaSchema,
  weights: z
    .array(z.int().min(0).max(100))
    .min(1)
    .max(8)
    .refine((weights) => weights.some((weight) => weight > 0), {
      message: 'At least one weight must be greater than zero',
    }),
});
export const fareSplitPreviewSchema = z
  .strictObject({
    totalPaisa: paisaSchema,
    shares: z.array(paisaSchema).min(1).max(8),
  })
  .refine(
    (preview) => preview.shares.reduce((sum, share) => sum + share, 0) === preview.totalPaisa,
    {
      message: 'Shares must add up to the total fare',
    },
  );

export type FareSplitRequest = z.infer<typeof fareSplitRequestSchema>;
export type FareSplitPreview = z.infer<typeof fareSplitPreviewSchema>;
