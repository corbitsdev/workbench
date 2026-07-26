/**
 * Generative UI inventory for Myra and workflow block authors (CL-3547).
 * Each entry documents one `UIBlock` kind the client renders via `UIBlockView`.
 */
export type UIBlockKindInventoryEntry = {
  kind: string;
  label: string;
  useWhen: string;
};

export const UI_BLOCK_KIND_INVENTORY: readonly UIBlockKindInventoryEntry[] = [
  {
    kind: "text",
    label: "Plain text",
    useWhen: "Fallback prose or a short status line.",
  },
  {
    kind: "markdown",
    label: "Markdown",
    useWhen: "Rich formatted copy with optional collapsible title.",
  },
  {
    kind: "document",
    label: "Document",
    useWhen: "Long markdown deliverable with copy/download actions.",
  },
  {
    kind: "card",
    label: "Card",
    useWhen:
      "Single entity summary — company, deal, person, or decision snapshot.",
  },
  {
    kind: "list",
    label: "List",
    useWhen:
      "Scannable bullets or numbered items with optional meta and badges.",
  },
  {
    kind: "table",
    label: "Table",
    useWhen: "Columnar numeric or categorical data.",
  },
  {
    kind: "preview",
    label: "Preview",
    useWhen:
      "Link or file preview with title, description, and optional thumbnail.",
  },
  {
    kind: "link",
    label: "Link",
    useWhen: "One outbound URL with short title and description.",
  },
  {
    kind: "choice",
    label: "Choice",
    useWhen: "Pick one option; use descriptions for card-style layouts.",
  },
  {
    kind: "form",
    label: "Form",
    useWhen: "Structured multi-field input for workflow gates.",
  },
  {
    kind: "multiSelect",
    label: "Multi-select",
    useWhen: "Pick N options from a set.",
  },
  {
    kind: "reviewList",
    label: "Review list",
    useWhen: "Approve or reject each row in a generated batch.",
  },
  {
    kind: "progress",
    label: "Progress",
    useWhen: "Step timeline for a running workflow.",
  },
  {
    kind: "comparison",
    label: "Comparison",
    useWhen: "A/B variant grid with streaming status.",
  },
  {
    kind: "error",
    label: "Error",
    useWhen: "Actionable failure with optional detail.",
  },
  {
    kind: "canvas",
    label: "Canvas",
    useWhen: "Compose multiple blocks under one title.",
  },
] as const;
