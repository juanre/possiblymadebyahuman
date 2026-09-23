import type { CaptureContextRedactions, SessionId } from "../../../../packages/producer-core/src/index.ts";
import type { BackgroundResponse, ContentToBackground, FinishScopePreview } from "../lib/messages.ts";

export type Send = (message: ContentToBackground) => Promise<BackgroundResponse>;
export type FinishOutcome =
  | { kind: "scope_changed"; preview: FinishScopePreview }
  | { kind: "binding_unavailable"; reason: string }
  | { kind: "response"; response: BackgroundResponse };

// Freeze/flush and binding are one worker-owned operation. A missing requested
// binding NEVER reaches sign_session; process-only is a separate human choice.
export async function finishRecord(send: Send, sessionId: SessionId, bind: boolean, redactions: CaptureContextRedactions, scopeToken?: string): Promise<FinishOutcome> {
  const prepared = await send({ kind: "prepare_finish", session_id: sessionId, bind, ...(bind && scopeToken ? { expected_scope_token: scopeToken } : {}) });
  if (prepared.kind !== "prepare_finish_result") {
    return { kind: "response", response: prepared };
  }
  if (prepared.scope_changed) return { kind: "scope_changed", preview: { scope: prepared.scope ?? "unavailable", scope_token: prepared.scope_token, reason: prepared.reason } };
  if (bind && !prepared.text_binding) {
    return { kind: "binding_unavailable", reason: prepared.reason ?? "The chosen wording is unavailable." };
  }
  if (!bind && prepared.reason) return { kind: "response", response: { kind: "error", reason: prepared.reason } };
  return {
    kind: "response",
    response: await send({
      kind: "sign_session", session_id: sessionId,
      ...(prepared.text_binding ? { text_binding: prepared.text_binding } : {}),
      ...(Object.keys(redactions).length ? { capture_context_redactions: redactions } : {}),
    }),
  };
}

export class OperationGuard {
  busy = false;
  async run(action: () => Promise<void>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try { await action(); } finally { this.busy = false; }
    return true;
  }
}

export async function copyRecordLink(url: string, clipboard: Pick<Clipboard, "writeText">): Promise<string> {
  try {
    await clipboard.writeText(url);
    return "Link copied.";
  } catch {
    return "Copy was blocked. Select the complete link above and copy it yourself; your record is saved.";
  }
}
