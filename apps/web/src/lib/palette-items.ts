import type { PaletteResultItem } from "@workbench/shared";

// Display order and headers for palette result categories. Navigation commands
// are client-side; the remaining categories are produced by the server-side
// aggregate search (CL-2500). Entity rows are normalized to PaletteResultItem
// on the server, so the web side only needs grouping metadata here.

export const PALETTE_CATEGORY_ORDER: PaletteResultItem["category"][] = [
  "navigation",
  "conversation",
  "agent",
  "workflow",
  "artifact",
  "skill",
  "tool",
];

export const PALETTE_CATEGORY_LABELS: Record<
  PaletteResultItem["category"],
  string
> = {
  navigation: "Go to",
  conversation: "Conversations",
  agent: "Agents",
  workflow: "Workflows",
  artifact: "Artifacts",
  skill: "Skills",
  tool: "Tools",
};
