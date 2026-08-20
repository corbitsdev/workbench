// The concept vocabulary: the words an agent uses to ask for a model.
//
// Pure data, no branching and no network, so it is importable on its own —
// the `CATALOG_SEEDS` idiom. It is deliberately not a table: this is product
// vocabulary that ships with the build and has to be reviewable in a diff,
// and a table would be a second store for something the bench policy row
// already parameterizes. A bench deviates through its policy's concept
// ceilings and allow/deny lists, never by forking the vocabulary.
//
// Ceilings are USD per million tokens, input and output kept separate — a
// blended number would hide which axis a workload actually spends on. They
// are soft by default: a model over ceiling is flagged and sorted last, not
// dropped, so a bench whose only provider is expensive still gets an answer.
//
// Capabilities are `@intx/types`' vocabulary, the one `model_offering`
// stores and source resolution filters on. It is narrower than the pinned
// catalog's: `long-context` and `prompt-caching` are baked onto catalog
// offerings but are not storable capability values, so no concept can filter
// on them. Where a concept wanted "handles a huge input", its reference mix
// carries that meaning instead — a 10M-token input mix ranks the model that
// is cheap on enormous inputs first, which is the decision the capability
// was standing in for.
import type { Capability } from "@intx/types";

/** The token mix that defines "cheapest" for a concept, in millions of
 * tokens. An input-heavy concept ranks a cheap-input model first; an
 * output-heavy one ranks cheap output first. */
export type ReferenceMix = {
  readonly inputMTok: number;
  readonly outputMTok: number;
};

export type ConceptCeiling = {
  readonly maxInputUsdPerMTok: number;
  readonly maxOutputUsdPerMTok: number;
};

export type ConceptSpec = {
  /** Stable kebab-case slug; the id an agent asks by. */
  readonly id: string;
  readonly title: string;
  /** One sentence in the reader's language, shown to agents choosing. */
  readonly whenToUse: string;
  /** An offering must advertise every one of these to qualify. */
  readonly requires: readonly Capability[];
  /** Bonus capabilities: they break ties, they never filter. */
  readonly prefers: readonly Capability[];
  readonly ceiling: ConceptCeiling;
  readonly referenceMix: ReferenceMix;
};

/** The mix used when the caller asks by raw capabilities rather than by
 * concept: mostly-input work with a short answer, the shape of the median
 * request. No ceiling applies to a bare capability ask. */
export const DEFAULT_MIX: ReferenceMix = { inputMTok: 1, outputMTok: 0.25 };

export const CONCEPTS: readonly ConceptSpec[] = [
  {
    id: "cheap-loop",
    title: "Cheap loop",
    whenToUse: "A step that runs hundreds of times: classify, tag, route.",
    requires: ["plain-text"],
    prefers: ["structured-output"],
    ceiling: { maxInputUsdPerMTok: 0.3, maxOutputUsdPerMTok: 1.0 },
    referenceMix: { inputMTok: 1, outputMTok: 0.05 },
  },
  {
    id: "bulk-extraction",
    title: "Bulk extraction",
    whenToUse: "Pull fields out of a pile of documents into a fixed shape.",
    requires: ["plain-text", "structured-output"],
    prefers: ["document-input"],
    ceiling: { maxInputUsdPerMTok: 0.6, maxOutputUsdPerMTok: 2.5 },
    referenceMix: { inputMTok: 4, outputMTok: 0.1 },
  },
  {
    id: "long-document",
    title: "Long document",
    whenToUse: "Read something very large end to end and answer about it.",
    requires: ["plain-text"],
    prefers: ["document-input", "structured-output"],
    ceiling: { maxInputUsdPerMTok: 3.0, maxOutputUsdPerMTok: 12.0 },
    referenceMix: { inputMTok: 10, outputMTok: 0.25 },
  },
  {
    id: "judgment-heavy",
    title: "Judgment heavy",
    whenToUse: "Hard calls where being right matters more than being cheap.",
    requires: ["plain-text", "reasoning-content"],
    prefers: ["function-calling-with-thinking"],
    ceiling: { maxInputUsdPerMTok: 6.0, maxOutputUsdPerMTok: 30.0 },
    referenceMix: { inputMTok: 1, outputMTok: 1 },
  },
  {
    id: "everyday-assistant",
    title: "Everyday assistant",
    whenToUse: "Live chat with a person, using tools as it goes.",
    requires: ["plain-text-streaming", "function-calling-multi-turn-streaming"],
    prefers: ["vision-input"],
    ceiling: { maxInputUsdPerMTok: 3.0, maxOutputUsdPerMTok: 15.0 },
    referenceMix: { inputMTok: 2, outputMTok: 0.5 },
  },
  {
    id: "agentic-workhorse",
    title: "Agentic workhorse",
    whenToUse: "Multi-step tool work run unattended to completion.",
    requires: ["function-calling-multi-turn", "structured-output"],
    prefers: ["reasoning-content"],
    ceiling: { maxInputUsdPerMTok: 3.0, maxOutputUsdPerMTok: 15.0 },
    referenceMix: { inputMTok: 3, outputMTok: 1 },
  },
  {
    id: "deep-tool-reasoner",
    title: "Deep tool reasoner",
    whenToUse: "Long autonomous work where a wrong tool call is expensive.",
    requires: ["function-calling-with-thinking", "reasoning-content"],
    prefers: ["redacted-thinking"],
    ceiling: { maxInputUsdPerMTok: 8.0, maxOutputUsdPerMTok: 40.0 },
    referenceMix: { inputMTok: 3, outputMTok: 1 },
  },
  {
    id: "code-work",
    title: "Code work",
    whenToUse: "Read, write and run code against a repository.",
    requires: ["function-calling-multi-turn", "structured-output"],
    prefers: ["code-execution", "reasoning-content"],
    ceiling: { maxInputUsdPerMTok: 4.0, maxOutputUsdPerMTok: 20.0 },
    referenceMix: { inputMTok: 5, outputMTok: 1 },
  },
  {
    id: "image-reader",
    title: "Image reader",
    whenToUse: "Screenshots, scans, diagrams — describe or extract from them.",
    requires: ["vision-input", "plain-text"],
    prefers: ["document-input", "structured-output"],
    ceiling: { maxInputUsdPerMTok: 3.0, maxOutputUsdPerMTok: 12.0 },
    referenceMix: { inputMTok: 2, outputMTok: 0.25 },
  },
  {
    id: "image-maker",
    title: "Image maker",
    whenToUse: "Produce a picture rather than words.",
    requires: ["image-output"],
    prefers: ["vision-input"],
    ceiling: { maxInputUsdPerMTok: 2.0, maxOutputUsdPerMTok: 10.0 },
    referenceMix: { inputMTok: 1, outputMTok: 0.5 },
  },
  {
    id: "voice-in",
    title: "Voice in",
    whenToUse: "Take spoken input — a recording or a live call.",
    requires: ["audio-input"],
    prefers: ["audio-input-streaming", "structured-output"],
    ceiling: { maxInputUsdPerMTok: 2.0, maxOutputUsdPerMTok: 10.0 },
    referenceMix: { inputMTok: 2, outputMTok: 0.5 },
  },
  {
    id: "fresh-facts",
    title: "Fresh facts",
    whenToUse: "Answers that must reflect the world right now, with sources.",
    requires: ["grounding", "plain-text"],
    prefers: ["grounding-streaming", "structured-output"],
    ceiling: { maxInputUsdPerMTok: 4.0, maxOutputUsdPerMTok: 16.0 },
    referenceMix: { inputMTok: 2, outputMTok: 0.5 },
  },
];

export const CONCEPT_IDS: readonly string[] = CONCEPTS.map(
  (concept) => concept.id,
);

export function conceptById(id: string): ConceptSpec | undefined {
  return CONCEPTS.find((concept) => concept.id === id);
}
