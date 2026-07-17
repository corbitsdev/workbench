import { type } from "arktype";
import type { ModelRequirement } from "@intx/types";
import { CATALOG_PROVIDERS } from "./providers";
import { CATALOG_MODELS } from "./models";
import { CATALOG_OFFERINGS } from "./offerings";
import {
  attachmentCapability,
  type AttachmentCapability,
} from "./attachment-capabilities";
import { contextWindowForModel } from "./context-windows";

const MODEL_PLUGINS = [
  "anthropic",
  "openai",
  "openai-compatible",
  "google-genai",
] as const;
export type ModelPlugin = (typeof MODEL_PLUGINS)[number];

export type CatalogProviderSpec = {
  name: string;
  plugin: ModelPlugin;
  credentialName: string;
  /** models.dev provider id used for Insights pricing when telemetry is a bare model id. */
  modelsDevProviderId?: string;
};

export type CatalogModelSpec = {
  canonicalName: string;
  /** models.dev `limit.context` for this model, in tokens. */
  contextWindow: number;
};

export type CatalogOfferingSpec = {
  model: string;
  provider: string;
  /**
   * Source-resolution ordering hint; lower wins the head/default slot and the
   * rest form the failover tail (@intx/db resolveModelSources sorts ascending).
   * Optional so the template-derived catalog can omit it; the static catalog
   * sets it on every row and the seeder defaults an absent value to 0.
   */
  priority?: number;
};

export type AgentCatalogSpec = {
  providers: CatalogProviderSpec[];
  models: CatalogModelSpec[];
  offerings: CatalogOfferingSpec[];
};

export type AgentTemplateInput = {
  key: string;
  name?: string | undefined;
  description?: string | undefined;
  systemPrompt?: string | undefined;
  credentialRequirements: readonly {
    source: string;
    providerName: string;
    name?: string | undefined;
    [key: string]: unknown;
  }[];
  grantRequirements?: readonly unknown[] | undefined;
  capabilities?: { tools: string[] } | undefined;
  modelConfig?: Record<string, unknown> | undefined;
  deployable?: boolean | undefined;
  kind?: string | undefined;
  toolPackages?: readonly unknown[] | undefined;
};

const ModelConfigShape = type({ defaultModel: "string" });

export function templateModelName(template: AgentTemplateInput): string {
  const parsed = ModelConfigShape(template.modelConfig ?? {});
  if (parsed instanceof type.errors) {
    throw new Error(
      `agent template "${template.key}" must declare modelConfig.defaultModel: ${parsed.summary}`,
    );
  }
  return parsed.defaultModel;
}

export function templateModelRequirements(
  template: AgentTemplateInput,
): ModelRequirement[] {
  return [{ model: templateModelName(template) }];
}

export function templateAttachmentCapability(
  template: AgentTemplateInput,
): AttachmentCapability {
  const { plugin } = inferenceCredential(template);
  return attachmentCapability(plugin, templateModelName(template));
}

function inferenceCredential(template: AgentTemplateInput): {
  plugin: ModelPlugin;
  credentialName: string;
} {
  const req = template.credentialRequirements.find(
    (r) =>
      r.source === "tenant" &&
      (MODEL_PLUGINS as readonly string[]).includes(r.providerName) &&
      typeof r.name === "string",
  );
  if (req === undefined || typeof req.name !== "string") {
    throw new Error(
      `agent template "${template.key}" has no tenant inference credential requirement`,
    );
  }
  return { plugin: req.providerName as ModelPlugin, credentialName: req.name };
}

const OFFERING_KEY_SEPARATOR = " ";

export function buildAgentCatalog(
  templates: readonly AgentTemplateInput[],
): AgentCatalogSpec {
  const providers = new Map<string, CatalogProviderSpec>();
  const models = new Map<string, CatalogModelSpec>();
  const offerings = new Map<string, CatalogOfferingSpec>();
  for (const template of templates) {
    const model = templateModelName(template);
    const cred = inferenceCredential(template);
    const providerName = cred.credentialName;
    providers.set(providerName, {
      name: providerName,
      plugin: cred.plugin,
      credentialName: cred.credentialName,
    });
    models.set(model, {
      canonicalName: model,
      contextWindow: contextWindowForModel(model),
    });
    offerings.set(`${model}${OFFERING_KEY_SEPARATOR}${providerName}`, {
      model,
      provider: providerName,
    });
  }
  return {
    providers: [...providers.values()],
    models: [...models.values()],
    offerings: [...offerings.values()],
  };
}

export const FULL_CATALOG: AgentCatalogSpec = {
  providers: CATALOG_PROVIDERS,
  models: CATALOG_MODELS,
  offerings: CATALOG_OFFERINGS,
};
