const TOOL_PREFIXES = ["granola_", "firecrawl_", "exa_"];

const ACRONYMS: Record<string, string> = {
  linkedin: "LinkedIn",
  pov: "POV",
  seo: "SEO",
  api: "API",
  url: "URL",
  csv: "CSV",
  ai: "AI",
  id: "ID",
  ui: "UI",
  ux: "UX",
  mcp: "MCP",
};

export function toHumanLabel(name: string): string {
  if (name === "") return "";
  let cleaned = name;
  for (const prefix of TOOL_PREFIXES) {
    if (cleaned.startsWith(prefix)) {
      cleaned = cleaned.slice(prefix.length);
      break;
    }
  }
  let isFirstWord = true;
  return cleaned
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .split(" ")
    .map((word) => {
      if (word === "") return word;
      const lower = word.toLowerCase();
      if (ACRONYMS[lower]) {
        isFirstWord = false;
        return ACRONYMS[lower];
      }
      if (isFirstWord) {
        isFirstWord = false;
        return word.charAt(0).toUpperCase() + lower.slice(1);
      }
      return lower;
    })
    .join(" ");
}

// Uncapped kebab-casing transform shared by toAssetName (asset naming, which
// caps at 64 chars) and isSlugShaped (shape detection, which must not cap —
// capping here would let a >64-char slug-shaped displayName evade detection
// since it would no longer equal its own capped slugification).
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Converts a display name to a lowercase-kebab asset name that satisfies
 * the Interchange skill asset name pattern /^[a-z0-9]+(-[a-z0-9]+)*$/.
 */
export function toAssetName(displayName: string): string {
  return slugify(displayName).slice(0, 64) || "skill";
}

// A skill's displayName is stored verbatim at creation time, so a
// user-supplied slug like "landing-page" persists as displayName rather than
// null. Detect that case (the string already equals its own uncapped
// slugification) and humanize it instead of trusting it as a real title.
// Exported so both the write side (createSkill's persist gate) and the read
// side (skillTitle) share one definition of "is this a slug" — a value that
// passes the write gate must be detected as a slug on render, and vice versa.
export function isSlugShaped(value: string): boolean {
  return value !== "" && value === slugify(value);
}

// Accepted false positive: a deliberate single-word lowercase title like
// "brief" is indistinguishable from a leaked slug and gets humanized to
// "Brief" too — harmless, since that's the same casing a real title would want.
export function skillTitle(skill: {
  name: string;
  displayName: string | null;
}): string {
  if (skill.displayName === null) return toHumanLabel(skill.name);
  if (isSlugShaped(skill.displayName)) return toHumanLabel(skill.displayName);
  return skill.displayName;
}
