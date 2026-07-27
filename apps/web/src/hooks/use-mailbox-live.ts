import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { subscribeMailboxEvents } from "../lib/mailbox-api";
import { MAILBOX_UNREAD_COUNT_KEY } from "./use-mailbox";

/**
 * Subscribes to the caller's mailbox delivery signal (SSE) and invalidates the
 * shared mailbox query the instant a new row lands, so the bell/inbox update
 * live rather than waiting for the next poll tick. The 30s poll in
 * useMailbox stays as a fallback — SSE can drop silently behind a proxy, so
 * this is a live nice-to-have layered on top, not the source of truth.
 *
 * EventSource is the sanctioned subscription pattern here (a stream, not a
 * data fetch) — see useWorkflowRunStateStream for the established precedent.
 */
export function useMailboxLive(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    return subscribeMailboxEvents(() => {
      void queryClient.invalidateQueries({ queryKey: ["mailbox"] });
      void queryClient.invalidateQueries({
        queryKey: MAILBOX_UNREAD_COUNT_KEY,
      });
    });
  }, [queryClient]);
}
