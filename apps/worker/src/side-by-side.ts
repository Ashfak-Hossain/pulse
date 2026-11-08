/**
 * Runs the worker's features until each ends. If one fails, the others are stopped too, so the worker
 * exits and restarts whole instead of running on with half its work stopped.
 */
export async function runSideBySide(
  controller: AbortController,
  features: (() => Promise<void>)[],
): Promise<void> {
  const results = await Promise.allSettled(
    features.map(async (feature) => {
      try {
        await feature();
      } catch (error) {
        controller.abort();
        throw error;
      }
    }),
  );
  const failed = results.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
}
