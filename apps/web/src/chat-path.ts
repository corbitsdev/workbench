// Chat deep links. `/chats/new` composes a first message to an agent;
// `/chats/:id` is one chat, addressed by its mailbox thread root uid (or
// a local id while the agent has not answered yet).

/** One key factory for every chat read, so a send can invalidate the
 * listing, the transcript, and the agent roster in one call. */
export const chatKeys = {
  scope: (tenantId: string) => ["tenant", tenantId, "chats"] as const,
  list: (tenantId: string) => ["tenant", tenantId, "chats", "list"] as const,
  agents: (tenantId: string) => ["tenant", tenantId, "chats", "agents"] as const,
  one: (tenantId: string, chatId: string) => ["tenant", tenantId, "chats", "one", chatId] as const,
  childTenants: (tenantId: string) => ["tenant", tenantId, "child-tenants"] as const,
};

/** One key factory per workbench (a workbench child tenant), so a send
 * invalidates the workbench's timeline and roster together. */
export const workbenchKeys = {
  scope: (tenantId: string) => ["workbench", tenantId] as const,
  tenant: (tenantId: string) => ["workbench", tenantId, "tenant"] as const,
  participants: (tenantId: string) => ["workbench", tenantId, "participants"] as const,
  timeline: (tenantId: string) => ["workbench", tenantId, "timeline"] as const,
};

export const CHATS_PATH_PREFIX = "/chats";
export const NEW_CHAT_PATH = `${CHATS_PATH_PREFIX}/new`;

export function chatPath(chatId: string): string {
  return `${CHATS_PATH_PREFIX}/${encodeURIComponent(chatId)}`;
}

export function chatIdFromPath(path: string): string | null {
  if (!path.startsWith(`${CHATS_PATH_PREFIX}/`)) return null;
  const segment = path.slice(CHATS_PATH_PREFIX.length + 1);
  if (segment === "" || segment === "new" || segment.includes("/")) return null;
  return decodeURIComponent(segment);
}

export function isChatPath(path: string): boolean {
  return path === CHATS_PATH_PREFIX || path.startsWith(`${CHATS_PATH_PREFIX}/`);
}
