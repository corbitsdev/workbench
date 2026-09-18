// Chat deep links. `/chats/new` composes a first message to an agent;
// `/chats/:id` is one chat, addressed by its mailbox thread root uid (or
// a local id while the agent has not answered yet).

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
