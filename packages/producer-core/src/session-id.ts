import type {
  FieldDescriptor,
  FieldOrigin,
  IdentityCertainty,
  SessionId,
  SessionRecord,
} from "./types.ts";

export type IdentityResolution = {
  session_id: SessionId;
  certainty: IdentityCertainty;
  resumed_from?: SessionRecord;
};

export function resolveSession(
  origin: FieldOrigin,
  descriptor: FieldDescriptor,
  existing: SessionRecord[],
  uuid: () => SessionId,
): IdentityResolution {
  const sameLocation = existing.filter(
    (record) =>
      record.origin.origin === origin.origin &&
      record.origin.path === origin.path &&
      record.descriptor.field_kind === descriptor.field_kind &&
      record.state !== "uploaded",
  );

  const exact = sameLocation.find((record) => isExactDescriptorMatch(record.descriptor, descriptor));
  if (exact) {
    const activeExactOnDifferentFrame = sameLocation.some(
      (record) => record !== exact && isExactDescriptorMatch(record.descriptor, descriptor) && record.state === "active",
    );
    if (activeExactOnDifferentFrame) {
      return { session_id: exact.session_id, certainty: "collision", resumed_from: exact };
    }
    return { session_id: exact.session_id, certainty: "resumed", resumed_from: exact };
  }

  const partial = sameLocation.find((record) => isPartialDescriptorMatch(record.descriptor, descriptor));
  if (partial) {
    return { session_id: uuid(), certainty: "degraded" };
  }

  return { session_id: uuid(), certainty: "fresh" };
}

export function isExactDescriptorMatch(left: FieldDescriptor, right: FieldDescriptor): boolean {
  return (
    left.tag_name === right.tag_name &&
    left.field_kind === right.field_kind &&
    left.name === right.name &&
    left.id === right.id &&
    left.aria_label === right.aria_label &&
    left.nearest_form_id === right.nearest_form_id &&
    left.dom_signature === right.dom_signature &&
    left.index_among_similar === right.index_among_similar
  );
}

export function isPartialDescriptorMatch(left: FieldDescriptor, right: FieldDescriptor): boolean {
  if (left.tag_name !== right.tag_name || left.field_kind !== right.field_kind) return false;
  const nameMatches = left.name !== null && right.name !== null && left.name === right.name;
  const idMatches = left.id !== null && right.id !== null && left.id === right.id;
  const ariaMatches = left.aria_label !== null && right.aria_label !== null && left.aria_label === right.aria_label;
  const formMatches =
    left.nearest_form_id !== null && right.nearest_form_id !== null && left.nearest_form_id === right.nearest_form_id;
  const indexMatches = left.index_among_similar === right.index_among_similar;
  const anchors = [nameMatches, idMatches, ariaMatches, formMatches, indexMatches].filter(Boolean).length;
  return anchors >= 2 && left.dom_signature !== right.dom_signature;
}
