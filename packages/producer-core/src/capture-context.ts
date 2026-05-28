import type { CaptureContext } from "../../format/src/index.ts";
import type { FieldDescriptor, FieldOrigin } from "./types.ts";

export type CaptureContextInput = {
  origin: FieldOrigin;
  descriptor: FieldDescriptor;
  page_title?: string | null;
  label?: string;
};

export function buildCaptureContext(input: CaptureContextInput): CaptureContext {
  const url = stripQueryAndHash(`${input.origin.origin}${input.origin.path}`);
  const ctx: CaptureContext = {
    surface: "browser",
    label: input.label ?? input.page_title ?? input.descriptor.field_kind,
    browser: {
      url,
      field_kind: input.descriptor.field_kind,
    },
  };
  if (input.page_title !== undefined && input.page_title !== null && ctx.browser) {
    ctx.browser.title = input.page_title;
  }
  return ctx;
}

export function redactCaptureContext(
  context: CaptureContext,
  redactions: { drop_title?: boolean; drop_url?: boolean; replace_label?: string },
): CaptureContext {
  const next: CaptureContext = JSON.parse(JSON.stringify(context));
  if (redactions.replace_label !== undefined) next.label = redactions.replace_label;
  if (next.browser) {
    if (redactions.drop_title) delete next.browser.title;
    if (redactions.drop_url) delete next.browser.url;
  }
  return next;
}

export function stripQueryAndHash(url: string): string {
  const hashIndex = url.indexOf("#");
  const trimmedHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = trimmedHash.indexOf("?");
  return queryIndex >= 0 ? trimmedHash.slice(0, queryIndex) : trimmedHash;
}
