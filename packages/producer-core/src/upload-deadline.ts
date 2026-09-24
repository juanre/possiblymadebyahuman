/** Covers the complete upload, including reading its response body. */
export const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;

export async function withUploadDeadline<T>(
  upload: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("upload timeout must be positive");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Upload timed out. The frozen record can be retried."));
      controller.abort();
    }, timeoutMs);
  });
  try {
    // Race independently of abort support; a late result must not reach callers.
    return await Promise.race([Promise.resolve().then(() => upload(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
