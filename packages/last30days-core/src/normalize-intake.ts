import { type } from "arktype";

// The two intake shapes the last30days-research gate can emit:
//   - the block-driven form (CL-2765): `{ topic, focus? }` verbatim — the human
//     types a topic and an optional focus, and a `form` UIBlock POSTs those two
//     fields unchanged;
//   - the legacy run-page panel (strangler fallback): `{ topic, query, days }`,
//     where the panel already derived `query = focus || topic` and pinned
//     `days: 30` client-side.
// Both cross the /resume boundary as loosely-typed records, so this is the raw,
// permissive shape — the normalization below is what pins it to the canonical
// downstream contract.
export const IntakeInputSchema = type({
  topic: "string",
  "focus?": "string",
  "query?": "string",
  "days?": "number",
});
export type IntakeInput = typeof IntakeInputSchema.infer;

// The canonical intake the research pipeline reads: a topic, a non-empty base
// query, and a day window. Every source's grounded/entity fallback query and the
// collect window derive from this, so it must never carry a blank query or an
// absent window.
export const NormalizedIntakeSchema = type({
  topic: "string",
  query: "string",
  days: "number",
});
export type NormalizedIntake = typeof NormalizedIntakeSchema.infer;

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Derive the canonical `{ topic, query, days }` the research pipeline reads from
 * whichever intake shape the gate emitted (CL-2765).
 *
 * This is the ONE place the panel's former client-side derivation now lives: the
 * block form emits `{ topic, focus }` verbatim, so `query = query || focus ||
 * topic` and `days` defaults to 30 here rather than in the browser. A run driven
 * by the block form and one driven by the legacy panel therefore hand the
 * downstream steps the identical `{ topic, query, days }` — a naive verbatim-form
 * migration (no derivation) would instead drop `focus`, collapsing the base query
 * to the bare topic (the #595 empty/blunted-prompt class this guards against).
 */
export function normalizeIntake(
  raw: Record<string, unknown>,
): NormalizedIntake {
  const topic = firstNonEmpty(raw.topic);
  if (topic === undefined) {
    throw new Error("workflow intake output must include topic");
  }
  const query = firstNonEmpty(raw.query, raw.focus) ?? topic;
  const days =
    typeof raw.days === "number" && Number.isFinite(raw.days) ? raw.days : 30;
  return { topic, query, days };
}
