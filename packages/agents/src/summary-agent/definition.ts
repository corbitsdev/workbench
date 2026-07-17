import type { CredentialRequirement, GrantRequirement } from "@intx/types";
import { buildSummaryAgentSystemPrompt } from "./prompt";
import type { AgentDeployDescriptor } from "../deploy-descriptor";
import { LLM_CREDENTIAL_NAME } from "../constants";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const SUMMARY_AGENT_GRANT_REQUIREMENTS: GrantRequirementType[] = [];

export const SUMMARY_AGENT_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] =
  [
    {
      providerName: "openai-compatible",
      source: "tenant",
      name: LLM_CREDENTIAL_NAME,
    },
  ];

export const SUMMARY_AGENT_DEPLOY_PROMPT: string =
  buildSummaryAgentSystemPrompt({ xml: true });

export const SUMMARY_AGENT_MODEL_CONFIG = {
  defaultModel: "deepseek-v4-flash",
} as const;

// The summarize compactor (`../summarize-compactor.ts`) consumes only
// `modelConfig.defaultModel` and the built system prompt from this
// descriptor — it is never deployed as its own agent instance. The
// remaining `AgentDeployDescriptor` fields (credentialRequirements,
// grantRequirements, defaultTools, requiredTools, label, name) are kept
// only because the type requires a full descriptor shape; they describe no
// real deployment.
export const SUMMARY_AGENT_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: "Summary Agent — Context Compactor",
  name: "Summary Agent",
  modelConfig: SUMMARY_AGENT_MODEL_CONFIG,
  systemPrompt: SUMMARY_AGENT_DEPLOY_PROMPT,
  credentialProviderNames: ["openai-compatible"],
  defaultTools: [],
  requiredTools: [],
};
