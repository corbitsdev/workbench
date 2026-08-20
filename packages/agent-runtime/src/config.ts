// Everything about an agent run that its deployed definition must know:
// which mailbox it answers on, what it is told to be, which models it
// may use, which tool packages and credentials it carries, and which of
// the two shapes it takes.
//
// This config is DEPLOY-TIME data, and under the workflow.json
// retirement it has to live inside the deployed package's own bytes.
// The approval probe and the run child each evaluate the deployment's
// entry module independently and the child refuses to run a definition
// whose recomputed wire hash differs from the approved one; the hashed
// projection covers the system prompt, the trigger address, the model
// pairs, the tool package pins, and the credential bindings — every
// field here. So a config delivered out of band (an env var, a file the
// sidecar drops next to the entry) diverges between the two evaluations
// and fails closed. `./source-tree.ts` renders it into the bytes
// instead.
import { type } from "arktype";
import { CredentialBinding } from "@intx/types";
import { ToolPackagePin } from "@intx/types/tool-packages";

const InferencePreference = type({
  provider: "string > 0",
  model: "string > 0",
  "parameters?": "Record<string, unknown>",
});

/**
 * One unbounded agent step on the run's own address: the folded
 * conversational shape. Every inbound mail is another turn of the same
 * step, and the run never completes on its own.
 */
const StepMode = type({
  kind: "'step'",
  /**
   * When present, the step reads this fixed value instead of the
   * triggering mail's `trigger.payload`. A run whose system prompt
   * forbids acting on what it receives (the workbench host) pins a
   * literal here so attachments-only mail — whose `content` is
   * legitimately empty — cannot crash the step before it opens.
   */
  "literalInput?": "unknown",
});

/**
 * One long-lived `onTrigger` section on the run's own address: each
 * inbound mail is one occurrence, run as its own child run with its own
 * id and event log, so a reply is traceable.
 */
const SectionMode = type({
  kind: "'section'",
  /** Per-occurrence timeout, enforced on the body's one step. */
  turnTimeoutMs: "number.integer > 0",
});

export const AgentRuntimeConfig = type({
  /** Definition id; also the base of the section body's id. */
  workflowId: "string > 0",
  /** The step agent's id — the folded run's instance id. */
  agentId: "string > 0",
  /** The mailbox this deployment answers on. */
  triggerAddress: "string > 0",
  systemPrompt: "string",
  /** Resolved catalog chain, in deploy order; the gate approves these. */
  inferencePreferences: InferencePreference.array().atLeastLength(1),
  /** Tool packages the step agent carries; no inline tool factories. */
  toolPackagePins: ToolPackagePin.array(),
  /** Definition-level bindings the host's per-step snapshot derives from. */
  credentialBindings: CredentialBinding.array(),
  mode: StepMode.or(SectionMode),
});
export type AgentRuntimeConfig = typeof AgentRuntimeConfig.infer;

/**
 * Parse `raw` as an `AgentRuntimeConfig`, throwing on any malformed
 * shape. A deploy whose config does not parse must fail before a
 * definition exists, not build a half-configured agent.
 */
export function parseAgentRuntimeConfig(raw: unknown): AgentRuntimeConfig {
  const parsed = AgentRuntimeConfig(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`invalid agent-runtime config: ${parsed.summary}`);
  }
  return parsed;
}
