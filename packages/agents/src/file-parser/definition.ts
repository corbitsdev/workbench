import { CredentialRequirement, GrantRequirement } from "@intx/types";

type GrantRequirementType = typeof GrantRequirement.infer;
type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * The File Parser is model-agnostic document understanding for agents whose own
 * model cannot read documents (CL-2628). It is bound to the Anthropic adapter,
 * which marshals PDF/document content blocks natively; a doc-incapable agent
 * (e.g. Myra on kimi via opencode-zen) reaches it through the `parse_file` tool
 * and reasons over its returned text.
 *
 * It is seeded as an org definition but never surfaced in the user agent catalog
 * (`deployable: false`) — it runs only as a one-shot in-hub inference turn keyed
 * off this definition's resolved inference source, never as a chat instance.
 */
export const FILE_PARSER_NAME = "File Parser";

export const FILE_PARSER_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] =
  [
    {
      providerName: "anthropic",
      source: "tenant",
      name: "anthropic-api",
    },
  ];

export const FILE_PARSER_MODEL_CONFIG = {
  defaultModel: "claude-sonnet-4-6",
} as const;

export const FILE_PARSER_GRANT_REQUIREMENTS: GrantRequirementType[] = [];

export { FILE_PARSER_SYSTEM_PROMPT } from "./prompt";
