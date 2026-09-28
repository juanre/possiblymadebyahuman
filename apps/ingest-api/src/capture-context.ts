/**
 * Producers released before records stopped describing where the text was
 * written still send capture_context. It is not signed, so it is discarded on
 * arrival and never stored; the record verifies without it.
 */
export function withoutCaptureContext(manifest: unknown): unknown {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest) || !("capture_context" in manifest)) return manifest;
  const { capture_context: _discarded, ...rest } = manifest as Record<string, unknown>;
  return rest;
}
