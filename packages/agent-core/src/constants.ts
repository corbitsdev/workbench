// Shared LLM credential name — all agents resolve the same tenant credential.
// Update this when switching the active model/provider.
export const LLM_CREDENTIAL_NAME = "opencode-zen";
export const LLM_DEFAULT_MODEL = "deepseek-v4-flash";

// Provider string the resolved tenant inference sources carry. A per-step model
// preference (inlineInferenceStep { model }) is matched against config.sources
// by (provider, model), so a step declaring a preferred model must name the same
// provider the catalog resolves the source under.
export const LLM_PROVIDER = "openai-compatible";

// A heavier model reserved for long-form synthesis steps (e.g. the last30days
// report writer) where reasoning depth beats latency. Opt in per-step via
// inlineInferenceStep({ model: LLM_WRITER_MODEL }); the workflow deploy resolves
// it into the tenant source set as an optional addition to LLM_DEFAULT_MODEL, so
// a step falls back to the default when the catalog does not carry it.
export const LLM_WRITER_MODEL = "kimi-k2.6";
