import {
  chatCapableModels,
  providerDisplayName,
} from "@corbits/inference-settings";
import type { ModelInfo } from "@corbits/inference-settings";

import { CHAT_STRINGS } from "./strings";

export const FAILED_TURN_MODEL_PICKER_LIMIT = 4;

export type FailedTurnModelChoice = {
  readonly canonicalName: string;
  readonly label: string;
};

/**
 * Two-to-four tenant-available chat models for the failed-turn strip
 * picker — the same connected, chat-capable filter Settings' agent
 * model select uses, capped so the strip stays a quiet inline row.
 */
export function failedTurnModelChoices(
  models: readonly ModelInfo[],
  limit = FAILED_TURN_MODEL_PICKER_LIMIT,
): readonly FailedTurnModelChoice[] {
  return chatCapableModels(models)
    .filter((model) => model.offerings.length > 0)
    .slice(0, limit)
    .map((model) => {
      const topOffering = model.offerings[0];
      return {
        canonicalName: model.canonicalName,
        label: CHAT_STRINGS.workbenchSettingsAgentDetailModelOption(
          model.displayName ?? model.canonicalName,
          topOffering === undefined
            ? ""
            : providerDisplayName(topOffering.providerName),
        ),
      };
    });
}
