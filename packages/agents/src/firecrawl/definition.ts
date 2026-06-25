import type { GrantRequirement, CredentialRequirement } from "@intx/types";
import { canonicalizeToolNames } from "../tool-names";
import { buildFirecrawlSystemPrompt } from "./prompt";
import type { AgentDeployDescriptor } from "../deploy-descriptor";
import { LLM_CREDENTIAL_NAME } from "../constants";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

export const FIRECRAWL_GRANT_REQUIREMENTS: GrantRequirementType[] = [
  { source: "invoker", resource: "tool:mail_search", action: "invoke" },
  { source: "invoker", resource: "tool:mail_reply", action: "invoke" },
];

/**
 * Credential requirements for the Freddy agent.
 *
 * Only the LLM credential is declared here — Interchange resolves these as
 * inference sources at launch time, and the sidecar validates each against the
 * LLM inference provider registry. The firecrawl API key is a non-LLM
 * credential resolved by the hub at tool execution time via the tool registry,
 * so declaring it here would push an unbuildable inference source and fail the
 * session launch ("Source provider 'firecrawl' is not registered").
 */
export const FIRECRAWL_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  {
    providerName: "openai-compatible",
    source: "tenant",
    name: LLM_CREDENTIAL_NAME,
  },
];

export const FIRECRAWL_DEPLOY_PROMPT: string = buildFirecrawlSystemPrompt(
  "Freddy",
  { xml: true },
);

export const FIRECRAWL_CAPABILITIES = {
  tools: canonicalizeToolNames([
    "firecrawl_scrape",
    "firecrawl_search",
    "firecrawl_map",
    "firecrawl_crawl_start",
    "firecrawl_crawl_status",
    "firecrawl_batch_scrape_start",
    "firecrawl_batch_scrape_status",
    "firecrawl_extract_start",
    "firecrawl_extract_status",
    "firecrawl_agent",
    "firecrawl_parse",
    "firecrawl_credit_usage",
    "firecrawl_token_usage",
    "mail_search",
    "mail_reply",
  ]),
} as const;

export const FIRECRAWL_MODEL_CONFIG = {
  defaultModel: "deepseek-v4-flash",
} as const;

export const FIRECRAWL_DEPLOY_DESCRIPTOR: AgentDeployDescriptor = {
  label: "Freddy — Web Intelligence",
  name: "Freddy",
  modelConfig: FIRECRAWL_MODEL_CONFIG,
  systemPrompt: FIRECRAWL_DEPLOY_PROMPT,
  credentialProviderNames: ["openai-compatible", "firecrawl"],
  defaultTools: [...FIRECRAWL_CAPABILITIES.tools],
  requiredTools: [...FIRECRAWL_CAPABILITIES.tools],
};
