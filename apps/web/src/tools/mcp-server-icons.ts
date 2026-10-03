// Which Lucide mark each MCP server's tile wears. The catalog itself stays
// platform-owned (`MCP_SERVER_CATALOG`); this only maps a handle to its icon,
// so an unknown or custom handle falls back to the plugs mark.

import { Captions, GitPullRequest, MagnifyingGlass, Plugs, type Icon } from "@/lib/icons";

const HANDLE_ICONS: Readonly<Record<string, Icon>> = {
  exa: MagnifyingGlass,
  granola: Captions,
  linear: GitPullRequest,
};

/** The tile mark for an MCP server handle; custom servers get the plugs mark. */
export function mcpServerIcon(handle: string): Icon {
  return HANDLE_ICONS[handle] ?? Plugs;
}
