// A worker's role line: the stock definition has no role field, so it is
// derived from what the worker can reach.

const MAX_ITEMS = 3;

const TOOL_FAMILIES: readonly (readonly [RegExp, string])[] = [
  [/^mail_/, "Mail"],
  [/^(posix|fs|shell)(_|$)/, "Files & shell"],
];

function titleCase(handle: string): string {
  return handle
    .split(/[-_\s]+/)
    .filter((word) => word !== "")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

export function workerRole(input: {
  readonly tools: readonly string[];
  readonly mcpServers: readonly string[];
  readonly isMyra: boolean;
}): string {
  if (input.isMyra) return "Assistant";
  const items = new Set<string>();
  for (const [pattern, label] of TOOL_FAMILIES) {
    if (input.tools.some((tool) => pattern.test(tool))) items.add(label);
  }
  for (const server of input.mcpServers) items.add(titleCase(server));
  const all = [...items];
  if (all.length === 0) return "No tools yet";
  const shown = all.slice(0, MAX_ITEMS).join(" · ");
  return all.length > MAX_ITEMS ? `${shown} +${all.length - MAX_ITEMS}` : shown;
}
