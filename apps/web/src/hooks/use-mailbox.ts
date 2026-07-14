import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { type } from "arktype";
import {
  MailboxBulkAction,
  MailboxBulkResponse,
  MailboxInboxView,
  MailboxListResponse,
  MailboxMessageDetail,
  MailboxUnreadCountResponse,
  type MailboxInboxView as MailboxInboxViewType,
  type MailboxMessage,
} from "@workbench/shared";
import { api, ApiError } from "../lib/api";

export type { MailboxMessage, MailboxMessageDetail };

export type { MailboxBulkAction };

// One shared cache entry per inbox view so folder tabs stay independent while
// the bell keeps its own "all" list for recent messages.
export const mailboxQueryKey = (view: MailboxInboxViewType = "all") =>
  ["mailbox", view] as const;

export const MAILBOX_UNREAD_COUNT_KEY = ["mailbox", "unread-count"] as const;

// Poll cadence for the ambient bell: mailbox deliveries arrive while the user is
// elsewhere in the app (a brief lands, a gate asks), so the live surface needs a
// gentle refetch. The durable /inbox page reads the same cache without its own
// interval.
export const MAILBOX_POLL_MS = 30_000;

// Matches the hub's DEFAULT_INBOX_LIMIT (apps/hub/src/routes/inbox.ts) so a page
// here is exactly one hub page — an explicit choice rather than relying on the
// server's implicit default.
export const MAILBOX_PAGE_LIMIT = 50;

type MailboxPage = typeof MailboxListResponse.infer;

async function fetchMailboxPage(
  view: MailboxInboxViewType,
  cursor: string | undefined,
): Promise<MailboxPage> {
  const params = new URLSearchParams({
    limit: String(MAILBOX_PAGE_LIMIT),
    view,
  });
  if (cursor !== undefined) params.set("cursor", cursor);
  const raw = await api<unknown>("GET", `/me/inbox?${params.toString()}`);
  const parsed = MailboxListResponse(raw);
  if (parsed instanceof type.errors) {
    throw new Error(`Unexpected mailbox response: ${parsed.summary}`);
  }
  return parsed;
}

/** @deprecated Prefer useMailboxUnreadCount for the notifications badge. */
export function unreadCount(
  messages: readonly MailboxMessage[] | undefined,
): number {
  if (!messages) return 0;
  return messages.reduce((count, message) => count + (message.read ? 0 : 1), 0);
}

export function useMailbox(options?: {
  view?: MailboxInboxViewType;
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  const view = options?.view ?? "all";
  return useInfiniteQuery({
    queryKey: mailboxQueryKey(view),
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchMailboxPage(view, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    select: (data) => data.pages.flatMap((page) => page.messages),
  });
}

export function useMailboxUnreadCount(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useQuery({
    queryKey: MAILBOX_UNREAD_COUNT_KEY,
    enabled: options?.enabled ?? true,
    refetchInterval: options?.refetchInterval ?? false,
    queryFn: async () => {
      const raw = await api<unknown>("GET", "/me/inbox/unread-count");
      const parsed = MailboxUnreadCountResponse(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected unread count: ${parsed.summary}`);
      }
      return parsed.unread;
    },
  });
}

export function useMailboxMessage(id: string | null) {
  return useQuery<MailboxMessageDetail, ApiError>({
    queryKey: ["mailbox", "message", id],
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

export function isMessageNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function patchMailboxPages(
  previous: InfiniteData<MailboxPage> | undefined,
  ids: Set<string>,
  patch: (message: MailboxMessage) => MailboxMessage | null,
): InfiniteData<MailboxPage> | undefined {
  if (!previous) return previous;
  return {
    ...previous,
    pages: previous.pages.map((page) => ({
      ...page,
      messages: page.messages.flatMap((message) => {
        if (!ids.has(message.id)) return [message];
        const next = patch(message);
        return next === null ? [] : [next];
      }),
    })),
  };
}

function invalidateMailboxQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ["mailbox"] });
}

export function useMarkMailboxRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api("POST", `/me/inbox/${encodeURIComponent(id)}/read`);
      return id;
    },
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: ["mailbox"] });
      const snapshots = queryClient.getQueriesData<InfiniteData<MailboxPage>>({
        queryKey: ["mailbox"],
      });
      for (const [key, previous] of snapshots) {
        if (!Array.isArray(key) || key[0] !== "mailbox" || typeof key[1] !== "string") {
          continue;
        }
        queryClient.setQueryData(
          key,
          patchMailboxPages(previous, new Set([id]), (message) => ({
            ...message,
            read: true,
          })),
        );
      }
      return { snapshots };
    },
    onError: (_error, _id, context) => {
      for (const [key, previous] of context?.snapshots ?? []) {
        queryClient.setQueryData(key, previous);
      }
    },
    onSettled: () => invalidateMailboxQueries(queryClient),
  });
}

export function useMarkMailboxUnread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api("POST", `/me/inbox/${encodeURIComponent(id)}/unread`);
      return id;
    },
    onSettled: () => invalidateMailboxQueries(queryClient),
  });
}

export function useMailboxBulkAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { action: MailboxBulkAction; ids: string[] }) => {
      const raw = await api<unknown>("POST", "/me/inbox/bulk", input);
      const parsed = MailboxBulkResponse(raw);
      if (parsed instanceof type.errors) {
        throw new Error(`Unexpected bulk response: ${parsed.summary}`);
      }
      return parsed;
    },
    onSettled: () => invalidateMailboxQueries(queryClient),
  });
}

export function useMailboxItemAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      action: "trash" | "archive" | "restore";
    }) => {
      await api(
        "POST",
        `/me/inbox/${encodeURIComponent(input.id)}/${input.action}`,
      );
      return input;
    },
    onSettled: () => invalidateMailboxQueries(queryClient),
  });
}

export function parseMailboxView(
  raw: string | null,
): MailboxInboxViewType | null {
  if (raw === null || raw === "") return "all";
  const parsed = MailboxInboxView(raw);
  if (parsed instanceof type.errors) return null;
  return parsed;
}