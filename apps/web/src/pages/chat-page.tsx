// Adapts this app's `/api/me/principals` query into `@corbits/chat-ui`'s
// `TenantResolution`: the account's first bench membership, the same
// personal-bench convention the onboarding flow uses. The chat surface
// itself is entirely `@corbits/chat-ui`'s — this file resolves which
// bench it talks to and mirrors the active channel into the URL as
// /chat/:channelId so conversations are linkable.

import { ChatWorkspace } from "@corbits/chat-ui";
import type { TenantResolution } from "@corbits/chat-ui";

import { PrincipalsSchema, useAPIQuery } from "../api";

const CHAT_PATH_PREFIX = "/chat";

function channelIdFromPath(path: string): string | null {
  if (!path.startsWith(`${CHAT_PATH_PREFIX}/`)) return null;
  const rest = path.slice(CHAT_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

export function ChatPage({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);

  let tenant: TenantResolution;
  if (principals.kind !== "ready") {
    tenant = principals;
  } else {
    const tenantId = principals.data.data[0]?.tenantId;
    tenant =
      tenantId === undefined ? { kind: "empty" } : { kind: "ready", tenantId };
  }

  return (
    <ChatWorkspace
      tenant={tenant}
      channelId={channelIdFromPath(path)}
      onChannelChange={(channelId) =>
        navigate(`${CHAT_PATH_PREFIX}/${encodeURIComponent(channelId)}`)
      }
    />
  );
}
