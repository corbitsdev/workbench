import { type } from "arktype";

// The tolerance envelope (CL-4464 follow-up).
//
// A native `action` step has no `nonFatal` escape (`ActionPrimitive` carries
// no such flag, and `runDeterministicToolStep` in
// apps/sidecar/src/step-tool-harness.ts throws whenever the dispatched tool's
// outer `ToolResult.isError` is `true`, unconditionally on the action path).
// So every "best-effort" wrapper this migration introduced — heartbeat's
// intake source, last30days' safe source tools, sumble-account-intel's
// facets/enrich-contacts, the prospect-engine ledger/mail/sumble/slack
// bridges, gamma/multi-source-collateral/reddit-opportunity-scanner's
// tolerant readers — always returns a completed, non-error outer
// `ToolResult`, and carries a genuine failure INSIDE `content` instead.
//
// Before this file, nine wrappers each hand-rolled that inner shape and
// disagreed: some used `{ isError: true, error }`, one used `{ ok: false,
// error }` / `{ ok: true, data }`, and several JSON-stringified the whole
// thing into a `content: string` (string-kind tools can only return
// `string`). This module is the ONE shape and ONE parser every wrapper and
// consumer now shares. Decision: failure is `{ isError: true, error }`
// (matches the majority of pre-existing wrappers and every existing
// consumer — `parseBriefSourceToolEnvelope`, `parseSourceStep`); success is
// the underlying tool's own content, unwrapped — a consumer that only cares
// about the happy path reads `content` directly, no envelope decoding. Each
// wrapper still owns its OWN try/catch around its OWN underlying tool; only
// the shape (here) and the dispatch mechanics
// (`@workbench/tool-credentials`'s `tolerance-envelope-dispatch.ts`, which
// needs `@intx/agent`/`@intx/types` and so cannot live in this
// Interchange-free package) are shared.
//
// This package is imported by both `apps/hub` and `apps/web` and may import
// no Interchange internals (see AGENTS.md) — so only the pure schema/parser
// live here; anything that dispatches an `AgentTool`/`ToolResult` call lives
// in `@workbench/tool-credentials` instead, which every one of the nine
// wrappers already depends on.

export const ToleranceEnvelopeFailureSchema = type({
  isError: "true",
  error: "string",
});
export type ToleranceEnvelopeFailure =
  typeof ToleranceEnvelopeFailureSchema.infer;

export function isToleranceEnvelopeFailure(
  value: unknown,
): value is ToleranceEnvelopeFailure {
  return !(ToleranceEnvelopeFailureSchema(value) instanceof type.errors);
}

/** Build the canonical failure `content` value a tolerant wrapper embeds. */
export function toleranceFailureContent(
  error: string,
): ToleranceEnvelopeFailure {
  return { isError: true, error };
}

export type ToleranceEnvelopeParse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Parse a tolerant wrapper's stored `content` (or a projected step's
 * `output.content`) into `{ ok, data }` / `{ ok: false, error }`. Handles
 * every wire shape a wrapper commits: a plain `{ isError: true, error }`
 * object, that same object JSON-stringified (a `kind: "string"` tool can
 * only return `string` content), a bare successful JSON payload, or a bare
 * non-JSON success string.
 */
export function parseToleranceEnvelope(
  content: unknown,
): ToleranceEnvelopeParse {
  let value: unknown = content;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return { ok: true, data: undefined };
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { ok: true, data: content };
    }
  }
  if (isToleranceEnvelopeFailure(value)) {
    return { ok: false, error: value.error };
  }
  return { ok: true, data: value };
}
