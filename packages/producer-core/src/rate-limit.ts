/** Consecutive 429 answers one publication request waits out before failing. */
export const MAX_RATE_LIMITED_RETRIES = 10;
const MAX_RETRY_AFTER_MS = 60_000;

/** How long a 429 answer asks the client to wait, from its Retry-After seconds. */
export function retryAfterMs(value: string | null | undefined): number {
  const seconds = Number(value);
  return value && Number.isFinite(seconds) && seconds >= 0 ? Math.min(MAX_RETRY_AFTER_MS, seconds * 1000) : 1000;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
