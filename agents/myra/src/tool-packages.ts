import type { ToolPackagePin } from "@intx/types/tool-packages";

// No `@intx/tools-posix`: Myra never gets raw filesystem access.
export const ASSISTANT_TOOL_PACKAGE_PINS: readonly ToolPackagePin[] = [
  { name: "@corbits/memory", version: "0.1.2" },
  { name: "@corbits/capability-tools", version: "0.0.7" },
  { name: "@corbits/agent-directory-tools", version: "0.0.7" },
  { name: "@corbits/catalog-tools", version: "0.1.1" },
  { name: "@corbits/skills-tools", version: "0.0.9" },
  { name: "@corbits/interaction-tools", version: "0.0.11" },
  { name: "@corbits/workflow-authoring-tools", version: "0.0.8" },
  { name: "@corbits/access-tools", version: "0.0.6" },
];
