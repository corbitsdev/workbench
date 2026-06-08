/**
 * Describes everything the UI needs to render a premade agent option
 * and provision it via the hub API.
 */
export type AgentDeployDescriptor = {
  /** Display label shown in the UI. */
  label: string;
  /** Agent name stored in the DB. */
  name: string;
  /** System prompt sent to the hub at provisioning time. */
  systemPrompt: string;
  /**
   * Interchange provider names for credentials this agent requires.
   * The UI renders a credential picker per entry.
   */
  credentialProviderNames: string[];
  /** Tool names (from KNOWN_TOOLS) to attach to the agent on creation. */
  defaultTools: string[];
  /**
   * Tool names the agent cannot function without. Rendered as locked
   * (checked, non-toggleable) in the UI. Must be a subset of defaultTools.
   */
  requiredTools: string[];
};
