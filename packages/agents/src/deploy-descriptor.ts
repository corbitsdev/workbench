import { type } from "arktype";
import { ToolPackagePin } from "@intx/types/tool-packages";

/**
 * Describes everything the UI needs to render a premade agent option
 * and provision it via the hub API.
 *
 * This crosses the package boundary (consumed by `apps/web` via
 * `./browser` and by the hub at provisioning time), so it is the canonical
 * arktype schema with its TypeScript type derived from it.
 */
export const AgentDeployDescriptor = type({
  /** Display label shown in the UI. */
  label: "string",
  /** Agent name stored in the DB. */
  name: "string",
  /** System prompt sent to the hub at provisioning time. */
  systemPrompt: "string",
  /**
   * Workbench onboarding provider names. The UI renders a credential picker per
   * entry, but these are not copied into Interchange agent credentialRequirements.
   * Tool credentials are resolved server-side by the hub tool registry.
   */
  credentialProviderNames: "string[]",
  /** Tool names (from KNOWN_TOOLS) to attach to the agent on creation. */
  defaultTools: "string[]",
  /**
   * Tool names the agent cannot function without. Rendered as locked
   * (checked, non-toggleable) in the UI. Must be a subset of defaultTools.
   */
  requiredTools: "string[]",
  /** Interchange modelConfig patched onto the agent definition at deploy time. */
  "modelConfig?": { defaultModel: "string" },
  /**
   * Native tool packages this agent pins. Resolved by Interchange's
   * closure resolver at launch and materialized by the sidecar loader.
   * Distinct from `defaultTools` (hub-proxy tool names) — the two coexist
   * until every tool is migrated and the proxy is removed.
   */
  "toolPackages?": ToolPackagePin.array(),
});

export type AgentDeployDescriptor = typeof AgentDeployDescriptor.infer;
