// Default land: `/` is a hop onto the person's most recent chat, or the
// new-chat composer when they have none. Home as a dashboard does not
// earn its keep — `/` only exists as this hop.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { WorkbenchLoadingState } from "@/chat";
import { listChats } from "@/chat/threads-api";

import { useBench } from "../bench-context";
import { chatKeys, chatPath, NEW_CHAT_PATH } from "../chat-path";
import { useNavigate } from "../navigation";

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const chats = useQuery({
    queryKey: chatKeys.list(selectedTenantId ?? ""),
    enabled: selectedTenantId !== null,
    queryFn: () => listChats(selectedTenantId ?? ""),
  });

  const newest = chats.data?.[0];
  useEffect(() => {
    if (chats.data === undefined) return;
    navigate(newest === undefined ? NEW_CHAT_PATH : chatPath(newest.id));
  }, [chats.data, newest, navigate]);

  if (memberships.kind === "error" || chats.isError) {
    const cause: unknown = chats.error;
    const message =
      memberships.kind === "error"
        ? memberships.message
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return (
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<WarningCircle />}
          title="Couldn't load your chats"
          description={message}
          action={
            <Button variant="outline" onClick={() => navigate(NEW_CHAT_PATH)}>
              Start a new chat
            </Button>
          }
        />
      </PageShell>
    );
  }

  return (
    <div className="page-fill shell-route-loading">
      <WorkbenchLoadingState delayMs={0} />
    </div>
  );
}
