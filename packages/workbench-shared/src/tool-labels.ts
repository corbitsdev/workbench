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
