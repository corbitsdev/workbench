// Adapts this app's `/api/me/principals` query into `@corbits/chat-ui`'s
// `TenantResolution`: the account's first bench membership, the same
// personal-bench convention the onboarding flow uses. The chat surface
// itself is entirely `@corbits/chat-ui`'s — this file only resolves which
// bench it should talk to.

import { ChatWorkspace } from "@corbits/chat-ui";
import type { TenantResolution } from "@corbits/chat-ui";

import { PrincipalsSchema, useAPIQuery } from "../api";

export function ChatPage() {
  const principals = useAPIQuery("/api/me/principals", PrincipalsSchema);

  let tenant: TenantResolution;
  if (principals.kind !== "ready") {
    tenant = principals;
  } else {
    const tenantId = principals.data.data[0]?.tenantId;
    tenant =
      tenantId === undefined ? { kind: "empty" } : { kind: "ready", tenantId };
  }

  return <ChatWorkspace tenant={tenant} />;
}
