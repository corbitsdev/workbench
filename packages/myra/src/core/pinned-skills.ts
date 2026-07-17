import { formatDataSection, type PromptFormat } from "@workbench/prompts";

/** Maximum pinned skills indexed in the Myra prompt (CL-3765). */
export const MAX_PINNED_MYRA_SKILLS = 10;

export type MyraPromptSurface = "chat" | "triage";

export type PinnedSkillIndexEntry = {
  readonly name: string;
  readonly description: string;
};

const PINNED_SKILLS_FRAMING =
  "Procedures your human pinned — load_skill and follow them whenever the task matches; this list is an index only (not the skill bodies).";

/**
 * Whether a pinned skill should count toward the triage prompt index. Skills may
 * opt out with `myra-surface: chat-only` in their description; otherwise pinned
 * skills are triage-relevant.
 */
export function isPinnedSkillTriageRelevant(description: string | null | undefined): boolean {
  const d = description?.trim() ?? "";
  if (/myra-surface:\s*chat-only/i.test(d)) return false;
  return true;
}

/** First non-empty line of a skill description for the prompt index. */
export function oneLineSkillDescription(description: string | null | undefined): string {
  const raw = description?.trim() ?? "";
  if (!raw) return "No description.";
  const line = raw.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? raw;
  return line.length > 240 ? `${line.slice(0, 237)}…` : line;
}

export function filterPinnedEntriesForSurface(
  surface: MyraPromptSurface,
  entries: readonly PinnedSkillIndexEntry[],
  triageRelevantByIndex: readonly boolean[],
): PinnedSkillIndexEntry[] {
  if (surface === "chat") return [...entries];
  return entries.filter((_, i) => triageRelevantByIndex[i] === true);
}

/**
 * Render the pinned-skills index section, or `null` when there is nothing to
 * show. Names and one-line descriptions only — never skill bodies.
 */
export function renderPinnedSkillsSection(
  entries: readonly PinnedSkillIndexEntry[],
  format: PromptFormat,
): string | null {
  if (entries.length === 0) return null;

  const lines = entries.map((e) => `- ${e.name}: ${e.description}`);
  const body = `${PINNED_SKILLS_FRAMING}\n\n${lines.join("\n")}`;
  return formatDataSection({ tag: "pinned-skills", content: body }, format);
}