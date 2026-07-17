import type { UIResponse } from "@workbench/blocks";

/**
 * Resolve an interactive block's response into the resume payload delivered to
 * a workflow gate's `/resume` (CL-2684). This is the ONE contract every
 * block-driven gate resume goes through, shared by every payload-aware host —
 * WorkflowDock, run-page block hosts (`WorkflowRunPane` / `WorkflowRunBlocks`),
 * and Myra chat (`MyraChatSurface`) — so a form/choice block resumes
 * identically wherever it renders. See `docs/WORKFLOWS.md`.
 *
 * A response that carries a structured `payload` (a form's field map, a choice's
 * typed decision, a multiSelect's array) is delivered VERBATIM — this is the
 * whole point of the form/multiSelect blocks (CL-2715): the gate reads the
 * structured payload directly. A response with no payload (a plain free-text
 * choice, or free text typed into the dock) is wrapped as `{ instruction }`,
 * preserving the pre-block free-text HITL path.
 *
 * FormBlock always emits `value: ""`, so a Myra-dock path that forwarded only
 * `value` wrapped as `{ instruction: "" }` would resume every form gate with an
 * empty payload — the corruption the run-page fallback existed to prevent. This
 * helper closes that gap at the shared seam.
 */
export function resolveResumePayload(response: UIResponse): unknown {
  if (response.payload !== undefined) return response.payload;
  return { instruction: response.value };
}
