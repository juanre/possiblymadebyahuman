import { isExactDescriptorMatch, isPartialDescriptorMatch } from "../../../../packages/producer-core/src/index.ts";
import type {
  FieldDescriptor,
  FieldOrigin,
  SessionRecord,
} from "../../../../packages/producer-core/src/index.ts";

/**
 * Producer scope invariant from coord: no automatic snapshot of existing
 * non-empty fields. A non-empty field with no resumable session is INELIGIBLE
 * — the extension records nothing and surfaces this state via the badge.
 * A resumable session match (exact or partial) re-enters that session and
 * continues recording, even if the field currently shows non-empty content.
 * An uploaded session counts as resumable: the field's content is exactly the
 * process that session recorded, so editing on reopens it rather than
 * snapshotting the text as a fresh start.
 */
export function isFieldEligible(args: {
  origin: FieldOrigin;
  descriptor: FieldDescriptor;
  field_is_empty: boolean;
  existing_sessions: ReadonlyArray<SessionRecord>;
}): { eligible: true; reason: "fresh" | "resumable" } | { eligible: false; reason: "non_empty_field_no_resumable_session" } {
  if (args.field_is_empty) {
    return { eligible: true, reason: "fresh" };
  }
  if (findResumableSession(args.origin, args.descriptor, args.existing_sessions)) {
    return { eligible: true, reason: "resumable" };
  }
  return { eligible: false, reason: "non_empty_field_no_resumable_session" };
}

export function findResumableSession(
  origin: FieldOrigin,
  descriptor: FieldDescriptor,
  existing: ReadonlyArray<SessionRecord>,
): SessionRecord | null {
  // An active session wins over an uploaded one for the same field: the field
  // is already being recorded and must not spawn a second continuation.
  const candidates = existing.filter((session) =>
    session.origin.origin === origin.origin
    && session.origin.path === origin.path
    && session.descriptor.field_kind === descriptor.field_kind
    && (isExactDescriptorMatch(session.descriptor, descriptor) || isPartialDescriptorMatch(session.descriptor, descriptor)));
  return candidates.find((session) => session.state === "active")
    ?? candidates.find((session) => isExactDescriptorMatch(session.descriptor, descriptor))
    ?? candidates[0]
    ?? null;
}
