import { GrantRequirement, CredentialRequirement } from "@intx/types";
import { canonicalizeAgentCapabilityNames } from "@workbench/agent-core/tool-names";
import {
  MYRA_CATALOG_BARE_TOOL_NAMES,
  MYRA_PLATFORM_BARE_TOOL_NAMES,
} from "@workbench/agent-core/dynamic-tools-catalog";
import { promptFormatForProvider } from "@workbench/prompts";
import { buildPersonalAgentSystemPrompt } from "./prompt";
import { LLM_CREDENTIAL_NAME } from "@workbench/agent-core/constants";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export function buildPersonalAgentGrantRequirements(
  _workbenchTenantId: string,
): GrantRequirementType[] {
  return [];
}

// A 1-tuple, not an array: `PERSONAL_AGENT_PROMPT_FORMAT` below reads element
// 0 and there is exactly one requirement, so the length belongs in the type.
export const PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS: [
  CredentialRequirementType,
] = [
  {
    providerName: "openai-compatible",
    source: "tenant",
    name: LLM_CREDENTIAL_NAME,
  },
];

/**
 * kimi-k2.6 is the default Myra chat model: stronger long-form reasoning over
 * the opencode-zen (openai-compatible) gateway. deepseek-v4-flash remains a
 * selectable non-default variant for cost/latency-sensitive work.
 */
export const PERSONAL_AGENT_MODEL_CONFIG = {
  defaultModel: "kimi-k2.6",
} as const;

/** Display name of the personal agent; also the per-tenant seed idempotency key. */
export const PERSONAL_AGENT_NAME = "Myra";

/**
 * Display name of the ephemeral inbox-triage variant of Myra; the per-tenant
 * seed idempotency key for its own agent definition row (see
 * `MYRA_TRIAGE_MODEL_CONFIG`). A distinct definition — not a per-launch
 * override — because model binds at the agent-definition level
 * (`agent.modelRequirements`, resolved from `modelConfig` at seed time); there
 * is no per-session model override in `launchAgentSession` /
 * `SessionService.launchSession`.
 */
export const PERSONAL_AGENT_TRIAGE_NAME = "Myra Triage";

/**
 * Triage volume runs in the hundreds/day, so the ephemeral per-item triage
 * session launches on the cheap flash model rather than Myra's own chat
 * model — `deepseek-v4-flash` is the established convention for
 * cost/latency-sensitive agents (Loop, Oat, Walter, Hammy, Lincoln, Firecrawl
 * all use it). `@intx/types` `modelConfig` has no reasoning/effort field, so
 * there is nothing to set for "low reasoning" here.
 */
export const PERSONAL_AGENT_TRIAGE_MODEL_CONFIG = {
  defaultModel: "deepseek-v4-flash",
} as const;

/**
 * Section format follows the provider Myra actually runs inference on. Her
 * model (kimi-k2.6) is served through the `openai-compatible` credential
 * requirement above, so `promptFormatForProvider` selects Markdown — the format
 * non-Anthropic models are tuned for — rather than the XML that only Anthropic
 * models prefer. The provider is knowable here from the declared credential
 * requirement, so there is no need to default.
 */
export const PERSONAL_AGENT_PROMPT_FORMAT = promptFormatForProvider(
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS[0].providerName,
);

export const PERSONAL_AGENT_DEPLOY_PROMPT: string =
  buildPersonalAgentSystemPrompt(
    PERSONAL_AGENT_NAME,
    PERSONAL_AGENT_PROMPT_FORMAT,
    { model: PERSONAL_AGENT_MODEL_CONFIG.defaultModel },
  );

/** Deploy prompt for the canonical triage definition (names the triage model). */
export const PERSONAL_AGENT_TRIAGE_DEPLOY_PROMPT: string =
  buildPersonalAgentSystemPrompt(
    PERSONAL_AGENT_NAME,
    PERSONAL_AGENT_PROMPT_FORMAT,
    { model: PERSONAL_AGENT_TRIAGE_MODEL_CONFIG.defaultModel },
  );

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
/**
 * Hand-maintained mirror of the hub-native, non-package tool names Myra's
 * capability lists may legitimately declare — `search_tools` / `load_tools`
 * are catalog-runner locals added directly below; `task_create` is a
 * hub-backed tool (`apps/hub/src/tools/task-tools.ts`, also mirrored in
 * `@workbench/agents`' `HUB_ONLY_TOOL_SIDE_EFFECTS`). Neither ships from a
 * `@workbench/tools-*` package, so `canonicalizeAgentCapabilityNames` cannot
 * resolve them from the manifest table alone — this is the explicit
 * allowlist that keeps them from failing the build.
 */
const MYRA_NATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search_tools",
  "load_tools",
  "task_create",
]);

export const PERSONAL_AGENT_PLATFORM_TOOLS: string[] =
  canonicalizeAgentCapabilityNames(
    "Myra",
    ["search_tools", "load_tools", ...MYRA_PLATFORM_BARE_TOOL_NAMES],
    MYRA_NATIVE_TOOL_NAMES,
  );

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
  ...canonicalizeAgentCapabilityNames(
    "Myra",
    MYRA_CATALOG_BARE_TOOL_NAMES,
    MYRA_NATIVE_TOOL_NAMES,
  ),
];
