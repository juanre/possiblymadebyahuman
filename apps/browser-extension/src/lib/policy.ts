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
  for (const session of existing) {
    if (session.state === "uploaded") continue;
    if (session.origin.origin !== origin.origin) continue;
    if (session.origin.path !== origin.path) continue;
    if (session.descriptor.field_kind !== descriptor.field_kind) continue;
    if (isExactDescriptorMatch(session.descriptor, descriptor)) return session;
    if (isPartialDescriptorMatch(session.descriptor, descriptor)) return session;
  }
  return null;
}
