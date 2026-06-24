/** Conservative input token budget for ephemeral Myra v1 (96k context class). */
export const EPHEMERAL_INPUT_TOKEN_BUDGET = 96_000;

/** When estimated input tokens reach this fraction of the budget, compact before infer. */
export const EPHEMERAL_COMPACT_RATIO = 0.6;

/** After compaction, aim for this fraction of the budget so the model turn has headroom. */
export const EPHEMERAL_TARGET_RATIO_AFTER_COMPACT = 0.5;

export const EPHEMERAL_COMPACT_THRESHOLD_TOKENS = Math.floor(
  EPHEMERAL_INPUT_TOKEN_BUDGET * EPHEMERAL_COMPACT_RATIO
);

export const EPHEMERAL_TARGET_TOKENS_AFTER_COMPACT = Math.floor(
  EPHEMERAL_INPUT_TOKEN_BUDGET * EPHEMERAL_TARGET_RATIO_AFTER_COMPACT
);