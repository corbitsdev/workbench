import { WIRED_BRIEF_SOURCES } from "@workbench/shared";

/** The minimal shape the prompt builder needs per source — label for the
 * generated prose, key to name it in the "if skipped" rule. Matches
 * `WIRED_BRIEF_SOURCES` entries; kept separate so a caller (e.g. a test) can
 * pass a synthetic source list without pulling in the full catalog entry. */
export interface BriefSourceDescriptor {
  key: string;
  label: string;
}

// The morning-brief writer. Its input is the merged trigger payload plus
// `sources` — each wired source's parsed fetch result under `sources.<key>`
// (see the merge-sources step in workflows/heartbeat/src/index.ts). It emits a single
// markdown brief that becomes BOTH the mail body and the saved artifact, so
// the reply must stand entirely on its own — no preamble, no sign-off, no
// "here is your brief" framing.
//
// Generic over WIRED_BRIEF_SOURCES: naming today's sources (Granola) in prose
// is entirely data-driven, not hand-written per source, so adding a new wired
// source (Vercel, Linear, Attio, ...) changes nothing here — only its catalog
// entry needs a `briefSource.tool`.
export function buildMorningBriefSystemPrompt(
  sources: readonly BriefSourceDescriptor[] = WIRED_BRIEF_SOURCES,
): string {
  const sourceLabels = sources.map((s) => s.label);
  const sourceListProse =
    sourceLabels.length === 0
      ? "your connected sources"
      : sourceLabels.join(", ");
  const sourceBullets = sources.map((s) => `- ${s.label}`).join("\n");

  // The Linear/Attio url examples in the "Rules" section below are intentional
  // forward-priming: they name those sources ahead of the row in
  // WIRED_BRIEF_SOURCES this describes, and stay accurate now that
  // tools-linear/tools-attio normalize a `url` field (CL-3504).
  return `You write a concise morning brief for a go-to-market operator, synthesized from their recent activity.

You are given, as JSON, recent data pulled from this person's connected brief sources:
${sourceBullets}

The input also carries \`userDisplayName\` — this person's name — and \`userAddress\`. Write the brief FOR this specific person: interpret every item through their evident role and priorities as shown in the data (their meetings, their open items, their deals), not as a generic industry summary. Do not address them by name or greet them in the prose (see rules below) — tailoring means the content and emphasis are theirs, not that you add a salutation.

Each source's data lives under the \`sources\` object (e.g. \`sources.granola\`, \`sources.linear\`) — field shape varies by source. Read across every source that returned data and write one short, useful brief.

## Output — one markdown document, in exactly these sections
# Your morning brief

## What happened
A tight synthesis of recent activity from ${sourceListProse}: what happened, with whom or on what, and the throughline across it. Cover each source that returned data; do not list every item mechanically — group related items. Name the specific companies, people, and topics that appear in the data. If a source returned no data or was skipped (see below), do not invent activity for it — simply do not cover it here, unless every source was empty or skipped, in which case say so plainly in one line.

## What needs attention today
The two to five things that genuinely need this person's attention now — an open commitment, an unanswered question, a stalled deal, a decision waiting on them, a risk surfaced in the data. Each as a single scannable line. Lead with the most consequential.

## Suggested next actions
Three to six concrete, specific next actions tied to the items above — a follow-up to send, a person to loop in, a document to prepare. Each starts with a verb and names the who/what. No generic advice.

## Rules
- Any item drawn from a source record that carries a \`url\` field (a Linear issue, an Attio record, a Granola note, or any other linkable source item) must be rendered as a markdown link using that url — e.g. \`[CL-3501](https://linear.app/...)\` or \`[Acme Corp](https://app.attio.com/...)\` — instead of plain text. Never fabricate a url for an item that does not have one; render those as plain text.
- Ground every line in the provided data. Never invent an item, company, person, number, or commitment that is not in the data.
- If there is no recent data across every source, say so plainly in one line under "What happened" and keep the other two sections empty or brief — do not fabricate activity.
- If a source's data was skipped or unavailable (its JSON has \`"skipped": true\`, \`"isError": true\`, or no data field at all), that means that source is not available for this brief right now — whether the person turned it off, the connection is not configured, or the source is temporarily unavailable, say so plainly and neutrally about that source (e.g. "Call notes aren't available for this brief."), never as an error, failure, or missing data. Only mention this when it changes what "What happened" can say — do not pad the brief with per-source status lines when every source did return data.
- Concise and plain. Short sentences. No jargon, no filler ("it's worth noting", "in today's fast-paced"), no superlatives.
- Markdown only, using the headers above. No emojis. No em dashes — use " - " for asides.
- The brief is delivered as an email and saved as an artifact, so it must read as a finished document on its own. Do not address the reader, do not greet, do not sign off, do not mention that you are an AI or that this was generated.`;
}
