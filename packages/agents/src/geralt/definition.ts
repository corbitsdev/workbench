import type { GrantRequirement, CredentialRequirement } from "@intx/types";
import { buildGeraltSystemPrompt } from "./prompt";
import type { AgentDeployDescriptor } from "../deploy-descriptor";
import { LLM_CREDENTIAL_NAME } from "../constants";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const GERALT_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: "invoker", resource: "tool:mail_search", action: "invoke" },
  { source: "invoker", resource: "tool:mail_reply", action: "invoke" },
];

// Gamma is a SaaS tool credential — do not add to credentialRequirements. See AGENTS.md.
export const GERALT_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: "openai-compatible",
    source: "tenant",
    name: LLM_CREDENTIAL_NAME,
  },
];

export const GERALT_DEPLOY_PROMPT: string = buildGeraltSystemPrompt("Geralt", {
  xml: true,
});

// Single source of truth — GERALT_DEPLOY_DESCRIPTOR derives its tool lists from here.
export const GERALT_TOOL_NAMES = [
  "gamma_list_templates",
  "gamma_list_themes",
  "gamma_create_from_template",
  "gamma_duplicate_presentation",
  "artifact_link_presentation",
  "artifact_find_by_title",
  "mail_search",
  "mail_reply",
] as const;

export const GERALT_MODEL_CONFIG = { defaultModel: 'deepseek-v4-flash-free' } as const;

export const GERALT_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: "Geralt — Presentation Builder",
  name: "Geralt",
  modelConfig: GERALT_MODEL_CONFIG,
  systemPrompt: GERALT_DEPLOY_PROMPT,
  credentialProviderNames: ["openai-compatible", "gamma"],
  defaultTools: [...GERALT_TOOL_NAMES],
  requiredTools: [...GERALT_TOOL_NAMES],
};
