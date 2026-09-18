// The sidebar's two sections, over stock routes only. Workbenches are the
// bench's own child tenants (stock tenant listing); chats are the person's
// mail threads with one agent each (`@/chat`'s threads-api).

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { listChats, subscribeToInbox, type ChatSummary } from "@/chat/threads-api";
import { chatKeys } from "../chat-path";
import { createFetchStockHub, findOwnedTenants, type HubTenant } from "../needs-converge";

export type SidebarSections =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ready";
      readonly workbenches: readonly HubTenant[];
      readonly chats: readonly ChatSummary[];
    };

async function listChildTenants(tenantId: string): Promise<readonly HubTenant[]> {
  const tenants = await findOwnedTenants(createFetchStockHub());
  return tenants.filter((tenant) => tenant.parentId === tenantId);
}

export function useSidebarSections(tenantId: string | null): SidebarSections {
  const key = tenantId ?? "";
  const enabled = tenantId !== null;
  const queryClient = useQueryClient();

  const workbenches = useQuery({
    queryKey: chatKeys.childTenants(key),
    enabled,
    queryFn: () => listChildTenants(key),
  });
  const chats = useQuery({
    queryKey: chatKeys.list(key),
    enabled,
    queryFn: () => listChats(key),
  });

  // A mailbox event is the only signal that an agent has answered; the
  // stream carries no chat identity, so the listing is simply invalidated.
  useEffect(() => {
    if (tenantId === null) return;
    return subscribeToInbox(tenantId, () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.scope(tenantId) });
    });
  }, [tenantId, queryClient]);

  if (tenantId === null) return { kind: "ready", workbenches: [], chats: [] };
  for (const query of [workbenches, chats]) {
    if (query.isError) {
      const cause: unknown = query.error;
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
  }
  if (workbenches.data === undefined || chats.data === undefined) return { kind: "loading" };
  return { kind: "ready", workbenches: workbenches.data, chats: chats.data };
}
