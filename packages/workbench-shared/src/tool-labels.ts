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

// Mirrors apps/hub/src/services/skill-library.ts's toAssetName kebab-casing —
// a skill's displayName is stored verbatim at creation time, so a
// user-supplied slug like "landing-page" persists as displayName rather than
// null. Detect that case (the string already equals its own slugification)
// and humanize it instead of trusting it as a real title.
function isSlugShaped(value: string): boolean {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return value === slug;
}

export function skillTitle(skill: {
  name: string;
  displayName: string | null;
}): string {
  if (skill.displayName === null) return toHumanLabel(skill.name);
  if (isSlugShaped(skill.displayName)) return toHumanLabel(skill.displayName);
  return skill.displayName;
}
