// The deploy-time config contract for the agent-runtime source package.
//
// A code-sourced deploy evaluates this package's `interchange.workflow`
// entry module twice — once in the approval probe, once in the run child
// — and refuses to run unless both evaluations project to the same wire
// hash. The package bytes are therefore identical for every run: one
// published version, deployed over and over. Everything that differs per
// run (which mailbox it answers on, what it is told to be, which models
// it may use, which tool packages and credentials it carries) arrives as
// this config, parsed at the module's trust boundary before a definition
// is built from it.
//
// The config travels out of band from the bytes, in the child's
// environment under `AGENT_RUNTIME_CONFIG_ENV`. That is the only channel
// available: mutating the closure would change the bytes that the SRI
// pin and the content cache are keyed on, and no deploy frame field
// reaches the entry module's evaluation.
import { type } from "arktype";
import { CredentialBinding } from "@intx/types";
import { ToolPackagePin } from "@intx/types/tool-packages";

/**
 * The environment variable the entry module reads its config from. The
 * host that applies the frozen closure sets it identically for the
 * approval probe and for every run child, so both evaluations of the
 * same package produce the same definition and the same wire hash.
 */
export const AGENT_RUNTIME_CONFIG_ENV = "CORBITS_AGENT_RUNTIME_CONFIG";

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

/**
 * Read and parse the deploy-time config out of an environment map. The
 * entry module calls this with `process.env`; a missing or unparseable
 * value throws, because a workflow package with no config has no
 * definition to export.
 */
export function readAgentRuntimeConfig(
  env: Record<string, string | undefined>,
): AgentRuntimeConfig {
  const encoded = env[AGENT_RUNTIME_CONFIG_ENV];
  if (encoded === undefined || encoded === "") {
    throw new Error(
      `the agent-runtime workflow package requires its deploy-time config in ${AGENT_RUNTIME_CONFIG_ENV}`,
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch (cause) {
    throw new Error(
      `${AGENT_RUNTIME_CONFIG_ENV} does not hold valid JSON`,
      { cause },
    );
  }
  return parseAgentRuntimeConfig(decoded);
}

/**
 * Serialize a config for delivery in `AGENT_RUNTIME_CONFIG_ENV`. The
 * deploying host validates before it encodes, so a config that would
 * fail inside the child fails loud at the deploy call instead.
 */
export function encodeAgentRuntimeConfig(config: AgentRuntimeConfig): string {
  return JSON.stringify(parseAgentRuntimeConfig(config));
}
