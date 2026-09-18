import { chatCapableModels, providerDisplayName } from "@/settings/inference";
import type { ModelInfo } from "@/settings/inference";

import { CHAT_STRINGS } from "./strings";

export const FAILED_TURN_MODEL_PICKER_LIMIT = 4;

export type FailedTurnModelChoice = {
  readonly canonicalName: string;
  readonly label: string;
};

function offeringSupportsTools(capabilities: readonly string[]): boolean {
  return capabilities.some((capability) => capability.startsWith("function-calling"));
}

function toolCapableModels(models: readonly ModelInfo[]): readonly ModelInfo[] {
  const kept: ModelInfo[] = [];
  for (const model of chatCapableModels(models)) {
    const offerings = model.offerings.filter((offering) =>
      offeringSupportsTools(offering.capabilities),
    );
    if (offerings.length === 0) continue;
    kept.push(
      offerings.length === model.offerings.length ? model : { ...model, offerings: [...offerings] },
    );
  }
  return kept;
}

function toChoices(models: readonly ModelInfo[], limit: number): readonly FailedTurnModelChoice[] {
  return models
    .filter((model) => model.offerings.length > 0)
    .slice(0, limit)
    .map((model) => {
      const topOffering = model.offerings[0];
      return {
        canonicalName: model.canonicalName,
        label: CHAT_STRINGS.workbenchSettingsAgentDetailModelOption(
          model.displayName ?? model.canonicalName,
          topOffering === undefined ? "" : providerDisplayName(topOffering.providerName),
        ),
      };
    });
}

// Capped so the strip stays a quiet inline row.
export function failedTurnModelChoices(
  models: readonly ModelInfo[],
  limit = FAILED_TURN_MODEL_PICKER_LIMIT,
): readonly FailedTurnModelChoice[] {
  return toChoices(chatCapableModels(models), limit);
}

// The recovery set when the failure was that the model can't use tools.
export function failedTurnToolCapableModelChoices(
  models: readonly ModelInfo[],
  limit = FAILED_TURN_MODEL_PICKER_LIMIT,
): readonly FailedTurnModelChoice[] {
  return toChoices(toolCapableModels(models), limit);
}
