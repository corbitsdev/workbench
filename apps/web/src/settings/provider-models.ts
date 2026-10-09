// Models offered per provider kind, by `ProviderOption.id`. The first entry is
// the preselected default; an empty list means the model is typed in. This
// moves to a package later.
export type ProviderModel = { readonly id: string; readonly label: string };

export const PROVIDER_MODELS: Readonly<Record<string, readonly ProviderModel[]>> = {
  anthropic: [
    { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
    { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
    { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
    { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  ],
  openai: [
    { id: "gpt-5", label: "GPT-5" },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
    { id: "openai/gpt-5", label: "GPT-5" },
    { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { id: "x-ai/grok-4", label: "Grok 4" },
  ],
  xai: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.7-build-fast", label: "Grok 4.7 Build Fast" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
  codex: [{ id: "gpt-5.5", label: "GPT-5.5" }],
  custom: [],
};
