import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type } from "arktype";
import {
  MailboxListResponse,
  MailboxMessageDetail,
  type MailboxMessage,
} from "@workbench/shared";
import { api } from "../lib/api";

export type { MailboxMessage, MailboxMessageDetail };

// One shared cache entry so the /inbox page and the app-frame notifications bell
// read the SAME mailbox — the bell's unread badge and the page's list can never
// disagree, and a mark-read from either updates both. The route is user-scoped
// (/me/inbox resolves the caller's own principal), so the key carries no tenant.
export const MAILBOX_QUERY_KEY = ["mailbox"] as const;

// Poll cadence for the ambient bell: mailbox deliveries arrive while the user is
// elsewhere in the app (a brief lands, a gate asks), so the live surface needs a
// gentle refetch. The durable /inbox page reads the same cache without its own
// interval.
export const MAILBOX_POLL_MS = 30_000;

export function unreadCount(
  messages: readonly MailboxMessage[] | undefined,
): number {
  if (!messages) return 0;
  return messages.reduce((count, message) => count + (message.read ? 0 : 1), 0);
}

export function useMailbox(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useQuery<MailboxMessage[]>({
    queryKey: MAILBOX_QUERY_KEY,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    queryFn: async () => {
      const raw = await api<unknown>("GET", "/me/inbox");
      const parsed = MailboxListResponse(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected mailbox response: ${parsed.summary}`);
      }
      return parsed.messages;
    },
  });
}

// The reading pane's full-body fetch. Keyed under the mailbox root so a
// sweep of ["mailbox"] clears details too; enabled only while a message
// is selected.
export function useMailboxMessage(id: string | null) {
  return useQuery<MailboxMessageDetail>({
    queryKey: [...MAILBOX_QUERY_KEY, "message", id],
    enabled: id !== null,
    queryFn: async () => {
      if (id === null) {
        throw new Error("No message selected");
      }
      const raw = await api<unknown>(
        "GET",
        `/me/inbox/${encodeURIComponent(id)}`,
      );
      const parsed = MailboxMessageDetail(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected mailbox message: ${parsed.summary}`);
      }
      return parsed;
    },
  });
}

// Marks one message read (idempotent server-side). Optimistically flips the
// cached row so the unread badge and the row emphasis update the instant the
// user opens a message; a failed POST rolls the cache back, and the settle
// invalidation reconciles against the server's authoritative read state.
export function useMarkMailboxRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api("POST", `/me/inbox/${encodeURIComponent(id)}/read`);
      return id;
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: MAILBOX_QUERY_KEY });
      const previous =
        queryClient.getQueryData<MailboxMessage[]>(MAILBOX_QUERY_KEY);
      if (previous) {
        queryClient.setQueryData<MailboxMessage[]>(
          MAILBOX_QUERY_KEY,
          previous.map((message) =>
            message.id === id ? { ...message, read: true } : message,
          ),
        );
      }
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        queryClient.setQueryData(MAILBOX_QUERY_KEY, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: MAILBOX_QUERY_KEY });
    },
  });
}
