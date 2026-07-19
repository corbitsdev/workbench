import { APPROVAL_GATED_TOOL_NAMES } from "@workbench/agents";

/**
 * The LLM-safe tool names whose instance grant is minted `effect: "ask"` — the
 * approval-gated write set ({@link APPROVAL_GATED_TOOL_NAMES}). Interchange's
 * authz-extension parks each `ask` call awaiting a human decision, so every
 * write-classified tool (`sideEffect: "write"`) requires approval before it
 * runs. This is unconditional (CL-3940): there is no owner toggle and no env
 * kill-switch — write tools always prompt. Read-classified tools are absent
 * from this set, so their grants stay `allow` and run automatically.
 */
export async function resolveAskToolNamesForTenant(): Promise<
  ReadonlySet<string>
> {
  return APPROVAL_GATED_TOOL_NAMES;
}
