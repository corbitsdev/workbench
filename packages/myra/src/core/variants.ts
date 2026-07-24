import { type } from "arktype";
import { CredentialRequirement } from "@intx/types";
import { promptFormatForProvider, type PromptFormat } from "@workbench/prompts";
import {
  buildPersonalAgentSystemPrompt,
  PERSONAL_AGENT_PROMPT_VERSION,
} from "./prompt";
import {
  buildPersonalAgentSystemPromptV2,
  PERSONAL_AGENT_PROMPT_VERSION_V2,
} from "./prompts/v2";
import type { MyraPromptGeneration } from "./prompts";
import {
  PERSONAL_AGENT_BASE_TOOLS,
  PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
  PERSONAL_AGENT_DEPLOY_PROMPT,
  PERSONAL_AGENT_TRIAGE_DEPLOY_PROMPT,
  PERSONAL_AGENT_MODEL_CONFIG,
  PERSONAL_AGENT_NAME,
  PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
  PERSONAL_AGENT_TRIAGE_NAME,
} from "./definition";
import { MAILBOX_PERSONA_TOOLS } from "../personas/mailbox";

type CredentialRequirementType = typeof CredentialRequirement.infer;

/**
 * The inference provider a variant runs on. `openai-compatible` is the
 * opencode-zen gateway (deepseek/kimi); `anthropic` is Anthropic-native
 * (Opus). The provider decides both the credential requirement Interchange
 * resolves at launch and the prompt render format (`promptFormatForProvider`).
 */
export type MyraVariantProvider = "openai-compatible" | "anthropic";

export type MyraVariantCostTier = "standard" | "premium";

/**
 * The Opus variants declare a tenant-owned `anthropic` credential requirement
 * (mirrors Freddie in `@workbench/agents`). Interchange resolves it at launch
 * from the tenant's `anthropic-api` credential and builds a native Anthropic
 * inference source for the definition's `claude-opus-4-8` model — the same
 * mechanism the openai-compatible variants use with the opencode-zen key, so
 * no launch-path change is needed.
 */
const ANTHROPIC_CREDENTIAL_REQUIREMENTS: CredentialRequirementType[] = [
  { providerName: "anthropic", source: "tenant", name: "anthropic-api" },
];

/**
 * A Myra variant: an immutable, versioned template describing one deployable
 * definition of the personal agent. `id` is stable across versions;
 * `versionId` changes whenever the base prompt version or the variant's model/
 * tool posture would make two builds meaningfully different. A member selects a
 * variant `id` as their default; instances are minted lazily from the selected
 * variant's `seedName` definition and keep it for life.
 */
export type MyraVariant = {
  id: string;
  versionId: string;
  kind: "chat" | "triage";
  displayName: string;
  description: string;
  model: string;
  modelConfig: Record<string, unknown>;
  provider: MyraVariantProvider;
  /**
   * Relative cost band for the model: "premium" for the frontier Opus
   * variants, "standard" for the opencode-zen (deepseek/kimi) ones. Drives the
   * settings picker's cost signal — a coarse tier, not a price.
   */
  costTier: MyraVariantCostTier;
  credentialRequirements: CredentialRequirementType[];
  promptFormat: PromptFormat;
  /** The system prompt baked into the seeded definition for this variant. */
  deployPrompt: string;
  /**
   * The prompt generation this variant's prompt is built from. Launch-time
   * rebuilds (`composePersonalAgentPromptForInstance`) MUST dispatch on this —
   * rebuilding with a hardcoded generation silently reverts the variant's
   * prompt at every real launch.
   */
  promptGeneration: MyraPromptGeneration;
  /**
   * The authorized toolset (grant list) for this variant's definition. Chat
   * variants carry the full base toolset; triage variants carry the mailbox
   * persona's read-only loadout regardless of model — the ticket's hard rule.
   */
  toolPolicy: readonly string[];
  /**
   * The agent-definition name this variant seeds as (the per-tenant seed
   * idempotency key). Lazy binding resolves the deployed definition by this
   * name.
   */
  seedName: string;
  /** Stable template key in `AGENT_TEMPLATES`. */
  templateKey: string;
  isDefault: boolean;
  /**
   * Optional prompt tweak overlay hook applied on top of the base prompt. v1
   * ships no overlays; the seam exists so a variant can diverge its prompt
   * later without a new base.
   */
  promptOverlay?: (basePrompt: string) => string;
};

function versionId(id: string): string {
  return `${id}@${PERSONAL_AGENT_PROMPT_VERSION}`;
}

const OPUS_MODEL_CONFIG = { defaultModel: "claude-opus-4-8" } as const;
const DEEPSEEK_MODEL_CONFIG = { defaultModel: "deepseek-v4-flash" } as const;
const KIMI_K3_MODEL_CONFIG = { defaultModel: "kimi-k3" } as const;

function chatDeployPrompt(
  provider: MyraVariantProvider,
  model: string,
): string {
  return buildPersonalAgentSystemPrompt(
    PERSONAL_AGENT_NAME,
    promptFormatForProvider(provider),
    { model },
  );
}

/**
 * The immutable variant catalog. The two canonical variants map to the
 * existing `myra` / `myra-triage` templates and reference their exact seeded
 * definition (byte-identical fallback for members with no preference); the rest
 * are additional, non-default definitions selectable per member.
 *
 * NOTE: the canonical chat variant runs on `kimi-k2.6` (see
 * `PERSONAL_AGENT_MODEL_CONFIG`); canonical triage stays on `deepseek-v4-flash`
 * (`PERSONAL_AGENT_TRIAGE_MODEL_CONFIG`) for cost at inbox volume. An absent
 * preference reproduces those seeded definitions exactly.
 */
export const MYRA_VARIANTS: readonly MyraVariant[] = [
  {
    id: "myra-kimi-k2-6",
    versionId: versionId("myra-kimi-k2-6"),
    kind: "chat",
    displayName: "Myra (Kimi K2)",
    description:
      "The default Myra — Moonshot Kimi K2 over the opencode-zen gateway. Strong long-form reasoning.",
    model: PERSONAL_AGENT_MODEL_CONFIG.defaultModel,
    modelConfig: PERSONAL_AGENT_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "standard",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v1",
    deployPrompt: PERSONAL_AGENT_DEPLOY_PROMPT,
    toolPolicy: PERSONAL_AGENT_BASE_TOOLS,
    seedName: PERSONAL_AGENT_NAME,
    templateKey: "myra",
    isDefault: true,
  },
  {
    id: "myra-deepseek-v4-flash",
    versionId: versionId("myra-deepseek-v4-flash"),
    kind: "chat",
    displayName: "Myra (DeepSeek Flash)",
    description:
      "Myra on DeepSeek V4 Flash — faster and lower-cost for everyday work.",
    model: DEEPSEEK_MODEL_CONFIG.defaultModel,
    modelConfig: DEEPSEEK_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "standard",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v1",
    deployPrompt: chatDeployPrompt(
      "openai-compatible",
      DEEPSEEK_MODEL_CONFIG.defaultModel,
    ),
    toolPolicy: PERSONAL_AGENT_BASE_TOOLS,
    seedName: "Myra (DeepSeek Flash)",
    templateKey: "myra-chat-deepseek-v4-flash",
    isDefault: false,
  },
  {
    id: "myra-opus-4-8",
    versionId: versionId("myra-opus-4-8"),
    kind: "chat",
    displayName: "Myra (Opus)",
    description:
      "Highest-quality Myra on Anthropic Claude Opus 4.8 — deepest reasoning for demanding work.",
    model: OPUS_MODEL_CONFIG.defaultModel,
    modelConfig: OPUS_MODEL_CONFIG,
    provider: "anthropic",
    costTier: "premium",
    credentialRequirements: ANTHROPIC_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("anthropic"),
    promptGeneration: "v1",
    deployPrompt: chatDeployPrompt("anthropic", OPUS_MODEL_CONFIG.defaultModel),
    toolPolicy: PERSONAL_AGENT_BASE_TOOLS,
    seedName: "Myra (Opus)",
    templateKey: "myra-chat-opus-4-8",
    isDefault: false,
  },
  {
    id: "myra-kimi-k3",
    versionId: versionId("myra-kimi-k3"),
    kind: "chat",
    displayName: "Myra (Kimi K3)",
    description:
      "Myra on Moonshot Kimi K3 over OpenRouter — stronger agentic reasoning than Kimi K2 at a higher per-token cost, below Opus.",
    model: KIMI_K3_MODEL_CONFIG.defaultModel,
    modelConfig: KIMI_K3_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "premium",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v1",
    deployPrompt: chatDeployPrompt(
      "openai-compatible",
      KIMI_K3_MODEL_CONFIG.defaultModel,
    ),
    toolPolicy: PERSONAL_AGENT_BASE_TOOLS,
    seedName: "Myra (Kimi K3)",
    templateKey: "myra-chat-kimi-k3",
    isDefault: false,
  },
  {
    id: "myra-v2-kimi-k2-6",
    versionId: `myra-v2-kimi-k2-6@${PERSONAL_AGENT_PROMPT_VERSION_V2}`,
    kind: "chat",
    displayName: "Myra v2 (Kimi K2)",
    description:
      "Myra on the v2 prompt generation — adds an outcome-first reporting contract, a finish-before-yielding rule, and failure reporting. Same Kimi K2 model as the default.",
    model: PERSONAL_AGENT_MODEL_CONFIG.defaultModel,
    modelConfig: PERSONAL_AGENT_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "standard",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v2",
    deployPrompt: buildPersonalAgentSystemPromptV2(
      PERSONAL_AGENT_NAME,
      promptFormatForProvider("openai-compatible"),
      { model: PERSONAL_AGENT_MODEL_CONFIG.defaultModel },
    ),
    toolPolicy: PERSONAL_AGENT_BASE_TOOLS,
    seedName: "Myra v2 (Kimi K2)",
    templateKey: "myra-chat-v2-kimi-k2-6",
    isDefault: false,
  },
  {
    id: "myra-triage-deepseek-v4-flash",
    versionId: versionId("myra-triage-deepseek-v4-flash"),
    kind: "triage",
    displayName: "Myra Triage (DeepSeek Flash)",
    description:
      "The default inbox-triage Myra — DeepSeek V4 Flash. Cheap and fast for hundreds of items a day.",
    model: PERSONAL_AGENT_TRIAGE_MODEL_CONFIG.defaultModel,
    modelConfig: PERSONAL_AGENT_TRIAGE_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "standard",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v1",
    deployPrompt: PERSONAL_AGENT_TRIAGE_DEPLOY_PROMPT,
    toolPolicy: MAILBOX_PERSONA_TOOLS,
    seedName: PERSONAL_AGENT_TRIAGE_NAME,
    templateKey: "myra-triage",
    isDefault: true,
  },
  {
    id: "myra-triage-kimi-k2-6",
    versionId: versionId("myra-triage-kimi-k2-6"),
    kind: "triage",
    displayName: "Myra Triage (Kimi K2)",
    description:
      "Inbox-triage Myra on Moonshot Kimi K2 — stronger classification at higher per-item cost.",
    model: PERSONAL_AGENT_MODEL_CONFIG.defaultModel,
    modelConfig: PERSONAL_AGENT_MODEL_CONFIG,
    provider: "openai-compatible",
    costTier: "standard",
    credentialRequirements: PERSONAL_AGENT_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("openai-compatible"),
    promptGeneration: "v1",
    deployPrompt: chatDeployPrompt(
      "openai-compatible",
      PERSONAL_AGENT_MODEL_CONFIG.defaultModel,
    ),
    toolPolicy: MAILBOX_PERSONA_TOOLS,
    seedName: "Myra Triage (Kimi K2)",
    templateKey: "myra-triage-kimi-k2-6",
    isDefault: false,
  },
  {
    id: "myra-triage-opus-4-8",
    versionId: versionId("myra-triage-opus-4-8"),
    kind: "triage",
    displayName: "Myra Triage (Opus)",
    description:
      "Inbox-triage Myra on Anthropic Claude Opus 4.8 — best judgement for high-stakes inboxes.",
    model: OPUS_MODEL_CONFIG.defaultModel,
    modelConfig: OPUS_MODEL_CONFIG,
    provider: "anthropic",
    costTier: "premium",
    credentialRequirements: ANTHROPIC_CREDENTIAL_REQUIREMENTS,
    promptFormat: promptFormatForProvider("anthropic"),
    promptGeneration: "v1",
    deployPrompt: chatDeployPrompt("anthropic", OPUS_MODEL_CONFIG.defaultModel),
    toolPolicy: MAILBOX_PERSONA_TOOLS,
    seedName: "Myra Triage (Opus)",
    templateKey: "myra-triage-opus-4-8",
    isDefault: false,
  },
];

export const MyraVariantKind = type("'chat' | 'triage'");
export type MyraVariantKind = typeof MyraVariantKind.infer;

/**
 * The API-facing summary of a variant (the `/myra/variants` catalog shape).
 * Exported schema is the source of truth for the boundary.
 */
export const MyraVariantSummarySchema = type({
  id: "string",
  kind: "'chat' | 'triage'",
  displayName: "string",
  model: "string",
  description: "string",
  costTier: "'standard' | 'premium'",
  isDefault: "boolean",
});
export type MyraVariantSummary = typeof MyraVariantSummarySchema.infer;

export function listMyraVariants(): MyraVariantSummary[] {
  return MYRA_VARIANTS.map((v) => ({
    id: v.id,
    kind: v.kind,
    displayName: v.displayName,
    model: v.model,
    description: v.description,
    costTier: v.costTier,
    isDefault: v.isDefault,
  }));
}

export function getMyraVariant(id: string): MyraVariant | undefined {
  return MYRA_VARIANTS.find((v) => v.id === id);
}

/**
 * True when `id` names a variant of the given kind. With no kind, matches a
 * variant of any kind.
 */
export function isMyraVariantId(id: string, kind?: MyraVariantKind): boolean {
  const variant = getMyraVariant(id);
  if (!variant) return false;
  return kind === undefined || variant.kind === kind;
}

/**
 * The Myra surface (`chat` or `triage`) that a seeded template key belongs
 * to, or `null` when the key names no Myra variant — e.g. a non-Myra agent
 * template. Used to gate per-surface personalization (the style overlay) to
 * only Myra instances, independent of the "personal" template-kind marker
 * that gates operator-identity personalization.
 */
/**
 * The full variant a seeded template key belongs to, or `null` for non-Myra
 * templates. Launch-time prompt rebuilds use this to recover the variant's
 * prompt generation and model from the instance's stored template key.
 */
export function myraVariantForTemplateKey(
  templateKey: string,
): MyraVariant | null {
  return MYRA_VARIANTS.find((v) => v.templateKey === templateKey) ?? null;
}

export function myraSurfaceForTemplateKey(
  templateKey: string,
): MyraVariantKind | null {
  const variant = MYRA_VARIANTS.find((v) => v.templateKey === templateKey);
  return variant?.kind ?? null;
}

export function defaultMyraVariant(kind: MyraVariantKind): MyraVariant {
  const variant = MYRA_VARIANTS.find((v) => v.kind === kind && v.isDefault);
  if (!variant) {
    throw new Error(`No default Myra variant for kind "${kind}"`);
  }
  return variant;
}

/**
 * Resolve the variant a member's stored preference selects for `kind`, falling
 * back to the canonical default when the preference is absent, null, or names a
 * variant of the wrong kind. This is the single lazy-binding decision both
 * creation paths (chat thread, mailbox triage) share.
 */
export function resolveMyraVariant(
  kind: MyraVariantKind,
  selectedId: string | null | undefined,
): MyraVariant {
  if (selectedId != null) {
    const variant = getMyraVariant(selectedId);
    if (variant && variant.kind === kind) return variant;
  }
  return defaultMyraVariant(kind);
}
