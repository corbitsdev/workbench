import type { ToolFactoryManifest } from "./schema";

/**
 * Style bar for every string Myra's catalog exposes to `search_tools` /
 * `search_skills` (a `myraCatalog.summary`, or a per-tool manifest
 * `descriptions` entry): the tool/skill's decision surface, not documentation.
 *
 * - State the one job the tool does.
 * - Name concrete trigger conditions or inputs (when to reach for it, what it
 *   takes) — not what category it belongs to.
 * - No marketing prose: no banned adjectives (see {@link CATALOG_BANNED_PHRASES}),
 *   no vague verbs ("helps with", "handles", "manages various things").
 * - Concise: aim for one sentence, at most two — a third is a disambiguation
 *   exception (e.g. spelling out mutually exclusive read/write behavior), not
 *   a default.
 *
 * Enforced mechanically by {@link assertCatalogDescriptionStyle}: non-empty,
 * a length ceiling, and the banned-phrase list. The rest (states the one job,
 * names concrete triggers) is a human review bar — a lint rule cannot detect
 * "vague" prose, only forbidden words and length.
 */
export const CATALOG_BANNED_PHRASES: readonly string[] = [
  "powerful",
  "easily",
  "effortlessly",
  "seamless",
  "seamlessly",
  "robust",
  "leverage",
  "helps you",
  "helps with",
  "simple way",
  "intuitive",
  "cutting-edge",
  "cutting edge",
  "state-of-the-art",
  "state of the art",
  "best-in-class",
  "comprehensive",
  "various things",
];

/**
 * `myraCatalog.summary` length ceiling — roughly two plain sentences. This is
 * the package-level pitch shown once per package; it has no excuse to run
 * long. Per-tool manifest `descriptions` are not length-capped here: several
 * legitimately exceed two sentences to spell out parameter contracts and
 * disambiguating "do NOT call this with only X" guidance that also serves as
 * the tool's real (non-catalog) description — the length judgment call there
 * stays a human review bar, not a mechanical one.
 */
export const MAX_CATALOG_SUMMARY_LENGTH = 220;

function findBannedPhrase(text: string): string | null {
  const lower = text.toLowerCase();
  for (const phrase of CATALOG_BANNED_PHRASES) {
    if (lower.includes(phrase)) return phrase;
  }
  return null;
}

function checkNonEmptyAndBanned(
  text: string,
  where: string,
  errors: string[],
): void {
  if (text.trim() === "") {
    errors.push(`${where}: catalog text must not be empty`);
    return;
  }
  const banned = findBannedPhrase(text);
  if (banned !== null) {
    errors.push(
      `${where}: catalog text uses banned phrase "${banned}" — "${text}"`,
    );
  }
}

function checkSummary(text: string, where: string, errors: string[]): void {
  checkNonEmptyAndBanned(text, where, errors);
  if (text.length > MAX_CATALOG_SUMMARY_LENGTH) {
    errors.push(
      `${where}: catalog summary exceeds ${MAX_CATALOG_SUMMARY_LENGTH} chars (${text.length}) — "${text}"`,
    );
  }
}

/**
 * Mechanical rules on every catalog-exposed description string: non-empty, a
 * length ceiling, and no banned marketing phrase. Throws with every violation
 * listed (not just the first) so a single fix pass catches everything.
 */
export function assertCatalogDescriptionStyle(
  factories: readonly ToolFactoryManifest[],
): void {
  const errors: string[] = [];
  for (const manifest of factories) {
    if (manifest.myraCatalog != null) {
      checkSummary(
        manifest.myraCatalog.summary,
        `${manifest.factoryId} myraCatalog.summary`,
        errors,
      );
    }
    if (manifest.descriptions !== undefined) {
      for (const [bare, description] of Object.entries(manifest.descriptions)) {
        checkNonEmptyAndBanned(
          description,
          `${manifest.factoryId} descriptions.${bare}`,
          errors,
        );
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Catalog description style violations:\n${errors.join("\n")}`,
    );
  }
}
