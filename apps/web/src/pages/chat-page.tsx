// Adapts this app's bench selection (see ../bench-context.tsx) into
// `@corbits/chat-ui`'s `TenantResolution`. The chat surface itself is
// entirely `@corbits/chat-ui`'s — this file resolves which bench it talks
// to and mirrors the active channel into the URL as /chat/:channelId so
// conversations are linkable.

import { ChatWorkspace } from "@corbits/chat-ui";
import type { TenantResolution } from "@corbits/chat-ui";

import { useBench } from "../bench-context";

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
  const { memberships, selectedTenantId, selectedPrincipalId } = useBench();

  let tenant: TenantResolution;
  if (memberships.kind !== "ready") {
    tenant = memberships;
  } else {
    tenant =
      selectedTenantId === null
        ? { kind: "empty" }
        : { kind: "ready", tenantId: selectedTenantId };
  }
  const principalId = selectedPrincipalId ?? undefined;

  return (
    <ChatWorkspace
      tenant={tenant}
      {...(principalId !== undefined ? { currentUser: { principalId } } : {})}
      channelId={channelIdFromPath(path)}
      onChannelChange={(channelId) =>
        navigate(`${CHAT_PATH_PREFIX}/${encodeURIComponent(channelId)}`)
      }
    />
  );
}
