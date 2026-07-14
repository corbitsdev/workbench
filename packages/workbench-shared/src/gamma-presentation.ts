import { type } from "arktype";

// Resume-boundary contract for the gamma-presentation-creator `intake` gate
// (CL-2684). The intake collects the deck brief: a title and a Gamma template
// (both REQUIRED — the render step reads `deckTitle` + `gammaId`, so a hollow
// intake would render a titleless deck off no template), the optional
// audience/tone/goal that steer the generate prompt, an optional source (an
// artifact id, a Granola note id, or pasted text — the fetch steps are
// nonFatal and their argMap fields are optional, so a source-less intake
// still generates from the brief), and an optional `templateSystemPrompt` —
// the selected template's own authoring guidance, relayed by the client so
// the generate step can apply it in addition to the base prompt. Both the
// dock's block-driven form and the run-page panel POST this shape;
// registering it rejects a titleless/templateless intake at the /resume
// boundary rather than letting the render step fail deep in the run.
export const GammaIntakePayloadSchema = type({
  deckTitle: "string >= 1",
  gammaId: "string >= 1",
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
  "artifactId?": "string",
  "noteId?": "string",
  "text?": "string",
  "templateSystemPrompt?": "string",
});
export type GammaIntakePayload = typeof GammaIntakePayloadSchema.infer;
