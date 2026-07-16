import { type } from "arktype";

/**
 * Prompt-only personalization style axes (v1). Each axis is a mutually
 * exclusive set of options; every axis's default option composes to an EMPTY
 * snippet — an absent or default-only selection reproduces today's prompt
 * byte-identical. Non-default options each map to exactly one curated,
 * imperative 1-2 sentence snippet appended to the system prompt as its own
 * section. "None" options are honest behavior dials (they describe what
 * Myra will actually do), never claims that a capability was removed or
 * disabled — grant-level enforcement of "None" is a separate concern.
 */
export type StyleAxisId =
  | "personality"
  | "emojiUse"
  | "uiType"
  | "artifactUsage"
  | "toolUsage"
  | "skillUsage";

export interface StyleAxisOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Empty for the axis's default option. */
  readonly snippet: string;
}

export interface StyleAxis {
  readonly id: StyleAxisId;
  readonly label: string;
  readonly defaultOptionId: string;
  readonly options: readonly StyleAxisOption[];
}

export const STYLE_AXES: readonly StyleAxis[] = [
  {
    id: "personality",
    label: "Personality",
    defaultOptionId: "teammate",
    options: [
      {
        id: "teammate",
        label: "Teammate (default)",
        description: "A sharp colleague — plain, direct, no filler.",
        snippet: "",
      },
      {
        id: "professional",
        label: "Professional",
        description: "Formal and businesslike.",
        snippet:
          "Keep a formal, businesslike tone — precise language, no slang, minimal small talk.",
      },
      {
        id: "friendly",
        label: "Friendly",
        description: "Warm and conversational.",
        snippet:
          "Keep a warm, conversational tone — approachable and encouraging without losing substance.",
      },
      {
        id: "candid",
        label: "Candid",
        description: "Blunt and direct.",
        snippet:
          "Be blunt and direct — say the hard thing plainly, skip diplomatic softening.",
      },
      {
        id: "playful",
        label: "Playful",
        description: "Light and witty.",
        snippet:
          "Keep a light, witty tone — humor is welcome, but never at the expense of clarity.",
      },
      {
        id: "efficient",
        label: "Efficient",
        description: "Terse, no elaboration.",
        snippet:
          "Be terse — give the shortest correct answer, with no elaboration unless asked.",
      },
      {
        id: "cynical",
        label: "Cynical",
        description: "Dry and skeptical.",
        snippet:
          "Keep a dry, skeptical tone — question claims and hype rather than taking them at face value.",
      },
      {
        id: "expert",
        label: "Expert",
        description: "Speaks with technical authority.",
        snippet:
          "Speak with the authority of a domain specialist — technical precision, no hedging on things you know.",
      },
      {
        id: "caveman",
        label: "Caveman",
        description: "Short, blunt fragments.",
        snippet:
          "Speak in short, blunt fragments — drop articles and connectors, communicate the point with minimal words.",
      },
    ],
  },
  {
    id: "emojiUse",
    label: "Emoji use",
    defaultOptionId: "none",
    options: [
      {
        id: "none",
        label: "None (default)",
        description: "No emojis unless explicitly requested.",
        snippet: "",
      },
      {
        id: "limited",
        label: "Limited",
        description: "At most one emoji when it adds real clarity.",
        snippet:
          "Use an emoji sparingly — at most one per message, only when it adds real clarity or warmth.",
      },
      {
        id: "heavy",
        label: "Heavy",
        description: "Emoji used freely.",
        snippet:
          "Use emoji freely to add tone and visual texture to your replies.",
      },
    ],
  },
  {
    id: "uiType",
    label: "UI type",
    defaultOptionId: "sections",
    options: [
      {
        id: "sections",
        label: "Sections (default)",
        description: "Structured headers and lists.",
        snippet: "",
      },
      {
        id: "paragraphs",
        label: "Paragraphs",
        description: "Flowing prose.",
        snippet:
          "Write in flowing prose paragraphs rather than headers and bullet lists, unless the content is inherently a list.",
      },
    ],
  },
  {
    id: "artifactUsage",
    label: "Artifact usage",
    defaultOptionId: "default",
    options: [
      {
        id: "heavy",
        label: "Heavy",
        description: "Create an artifact for most substantial output.",
        snippet:
          "Create an artifact for any substantial output — even short deliverables — so the person you work for always has something to save or share.",
      },
      {
        id: "default",
        label: "Default",
        description: "Today's judgment call on when to create an artifact.",
        snippet: "",
      },
      {
        id: "light",
        label: "Light",
        description: "Only for long-form or clearly saved output.",
        snippet:
          "Only create an artifact when the output is long-form or clearly meant to be saved; keep everything else in the reply.",
      },
      {
        id: "none",
        label: "None",
        description: "Never create artifacts.",
        snippet: "Do not create artifacts; deliver results in the reply.",
      },
    ],
  },
  {
    id: "toolUsage",
    label: "Tool usage",
    defaultOptionId: "default",
    options: [
      {
        id: "heavy",
        label: "Heavy",
        description: "Reach for a tool whenever one could help.",
        snippet:
          "Reach for a tool whenever one could add precision or freshness, even for things you could plausibly answer from memory.",
      },
      {
        id: "default",
        label: "Default",
        description: "Today's judgment call on when to use a tool.",
        snippet: "",
      },
      {
        id: "light",
        label: "Light",
        description: "Only when the request clearly requires it.",
        snippet:
          "Prefer answering from the conversation and your own knowledge; use a tool only when the request clearly requires current or external data.",
      },
      {
        id: "none",
        label: "None",
        description: "Answer from memory only.",
        snippet:
          "Answer from the conversation and your memory only; say when a tool would be needed rather than using one.",
      },
    ],
  },
  {
    id: "skillUsage",
    label: "Skill usage",
    defaultOptionId: "default",
    options: [
      {
        id: "heavy",
        label: "Heavy",
        description: "Check for a written procedure before improvising.",
        snippet:
          "Check search_skills for a written procedure before improvising on anything beyond a simple, one-step ask.",
      },
      {
        id: "default",
        label: "Default",
        description: "Today's judgment call on when to check skills.",
        snippet: "",
      },
      {
        id: "light",
        label: "Light",
        description: "Only when the request is unfamiliar.",
        snippet:
          "Only check search_skills when the request is unfamiliar or clearly matches a documented procedure; otherwise proceed directly.",
      },
      {
        id: "none",
        label: "None",
        description: "Never search or follow skills.",
        snippet:
          "Do not search or follow skills; work directly from your own reasoning and tools.",
      },
    ],
  },
];

export const STYLE_AXIS_IDS: readonly StyleAxisId[] = STYLE_AXES.map(
  (a) => a.id,
);

export function getStyleAxis(id: StyleAxisId): StyleAxis | undefined {
  return STYLE_AXES.find((a) => a.id === id);
}

/** True when `optionId` names a real option of the given axis. */
export function isStyleAxisOptionId(
  axisId: StyleAxisId,
  optionId: string,
): boolean {
  const axis = getStyleAxis(axisId);
  if (!axis) return false;
  return axis.options.some((o) => o.id === optionId);
}

export const StyleAxisIdSchema = type(
  "'personality' | 'emojiUse' | 'uiType' | 'artifactUsage' | 'toolUsage' | 'skillUsage'",
);

/**
 * A member's selection across the style axes. Each key maps to an option id
 * of that axis, or `null`/absent to mean "use the axis's default option" —
 * the byte-identical current behavior.
 */
export type StyleAxisSelections = Partial<
  Record<StyleAxisId, string | null | undefined>
>;

/**
 * Compose the prompt overlay text for a set of axis selections: the joined,
 * curated snippets of every non-default selected option, one per line.
 * Unknown option ids are ignored (the API boundary validates before this is
 * ever called). Every-default (or empty) selections compose to `""` —
 * appending nothing keeps the prompt byte-identical to today.
 */
export const StyleAxisOptionSummarySchema = type({
  id: "string",
  label: "string",
  description: "string",
});
export type StyleAxisOptionSummary = typeof StyleAxisOptionSummarySchema.infer;

export const StyleAxisSummarySchema = type({
  id: StyleAxisIdSchema,
  label: "string",
  defaultOptionId: "string",
  options: StyleAxisOptionSummarySchema.array(),
});
export type StyleAxisSummary = typeof StyleAxisSummarySchema.infer;

/**
 * The API-facing style-axes catalog: every axis's id, label, default option
 * id, and options (id/label/description only — the curated snippet text is
 * server-side prompt copy, never shipped to the client).
 */
export function listStyleAxes(): StyleAxisSummary[] {
  return STYLE_AXES.map((axis) => ({
    id: axis.id,
    label: axis.label,
    defaultOptionId: axis.defaultOptionId,
    options: axis.options.map((o) => ({
      id: o.id,
      label: o.label,
      description: o.description,
    })),
  }));
}

export function composeStyleOverlay(selections: StyleAxisSelections): string {
  const snippets: string[] = [];
  for (const axis of STYLE_AXES) {
    const selectedId = selections[axis.id];
    if (selectedId == null) continue;
    const option = axis.options.find((o) => o.id === selectedId);
    if (!option || option.snippet === "") continue;
    snippets.push(option.snippet);
  }
  return snippets.join("\n");
}
