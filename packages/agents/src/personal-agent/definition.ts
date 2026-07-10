import { GrantRequirement, CredentialRequirement } from "@intx/types";
import { canonicalizeToolNames } from "../tool-names";
import {
  MYRA_CATALOG_BARE_TOOL_NAMES,
  MYRA_PLATFORM_BARE_TOOL_NAMES,
} from "../dynamic-tools/catalog";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import { LLM_CREDENTIAL_NAME } from "../constants";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export function buildPersonalAgentGrantRequirements(
  _workbenchTenantId: string,
): GrantRequirementType[] {
  return [];
}

export const PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] =
  [
    {
      providerName: "openai-compatible",
      source: "tenant",
      name: LLM_CREDENTIAL_NAME,
    },
  ];

export const PERSONAL_AGENT_MODEL_CONFIG = {
  defaultModel: "kimi-k2.6",
} as const;

/** Display name of the personal agent; also the per-tenant seed idempotency key. */
export const PERSONAL_AGENT_NAME = "Myra";

export const PERSONAL_AGENT_DEPLOY_PROMPT: string =
  buildPersonalAgentSystemPrompt(PERSONAL_AGENT_NAME, {
    xml: true,
  });

/**
 * The platform tools Myra advertises on every turn — the small, always-visible
 * core (CL-3190). These are workbench-native capabilities the model must be able
 * to reach without `load_tools`: catalog discovery (tools + skills), durable
 * memory, the minimal artifact surface for deliverables, and workflow entry
 * points. Skill discovery pairs `search_skills` with `load_skill` so a found
 * skill can be read and followed in the same turn. Everything else Myra carries
 * is catalog-managed (see MYRA_TOOL_CATALOG) and hidden until
 * `search_tools` → `load_tools` exposes it.
 */
export const PERSONAL_AGENT_PLATFORM_TOOLS: string[] = [
  "search_tools",
  "load_tools",
  ...canonicalizeToolNames(MYRA_PLATFORM_BARE_TOOL_NAMES),
];

/**
 * The full authorized toolset (the grant list) every Myra instance starts with.
 * Tool grants (`tool:<name>/invoke`) are synthesized from this list at launch
 * (persistInstanceToolGrants), so listing a tool here is what authorizes it —
 * this is NOT the turn-1 advertised set (see PERSONAL_AGENT_PLATFORM_TOOLS).
 *
 * Derived as platform ∪ catalog, so grants and the dynamic catalog cannot drift:
 * every integration Myra can `load_tools` is granted here, and every catalog
 * entry comes from MYRA_CATALOG_BARE_TOOL_NAMES — one source of truth (CL-3190).
 */
export const PERSONAL_AGENT_BASE_TOOLS: string[] = [
  ...PERSONAL_AGENT_PLATFORM_TOOLS,
  ...canonicalizeToolNames(MYRA_CATALOG_BARE_TOOL_NAMES),
];
