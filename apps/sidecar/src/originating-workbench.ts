// Originating workbench for the warm agent's durable conversation.
//
// Chat mail names the room it speaks for in the RFC 2822 From local-part
// (`fromWorkbenchId`). The step request carries THIS message's Mail as its
// input (the same object the workflow-host step invoker sends to the agent),
// so the room is read from the request itself -- never from a per-mailbox
// side-channel, which binds an earlier mail under a later room when two
// inbound messages enqueue before the first invokeStep. A request that
// carries no mail (an approval resume, a synthetic input) names no room and
// leaves the current binding alone; a mail without a usable From is
// `_unscoped` so a later room never inherits a mixed blob.

import { extractAddrSpec } from "@intx/mime";
import { isMail } from "@intx/types/runtime";
import type { StepInvokeRequest } from "@intx/workflow";

export const UNSCOPED_ORIGINATING_WORKBENCH_ID = "_unscoped";

/**
 * Local-part of a From header value. Chat encodes the originating workbench
 * id there; anything else (empty, unparseable) is undefined.
 */
export function extractOriginatingWorkbenchId(
  from: string,
): string | undefined {
  if (from.trim() === "") return undefined;
  try {
    const spec = extractAddrSpec(from);
    const at = spec.lastIndexOf("@");
    if (at <= 0) return undefined;
    return spec.slice(0, at);
  } catch {
    return undefined;
  }
}

export function resolveOriginatingWorkbenchId(
  fromWorkbenchId: string | undefined,
): string {
  return fromWorkbenchId !== undefined && fromWorkbenchId.length > 0
    ? fromWorkbenchId
    : UNSCOPED_ORIGINATING_WORKBENCH_ID;
}

/**
 * Room named by the mail this step request delivers, or undefined when the
 * request carries no mail. Mirrors the step invoker's own input selection:
 * a resume delivers its decision, anything else delivers `input`.
 */
export function originatingWorkbenchIdFromRequest(
  req: Pick<StepInvokeRequest, "input" | "resume">,
): string | undefined {
  const delivered = req.resume === undefined ? req.input : req.resume.decision;
  if (!isMail(delivered)) return undefined;
  return resolveOriginatingWorkbenchId(
    extractOriginatingWorkbenchId(delivered.headers.from),
  );
}
