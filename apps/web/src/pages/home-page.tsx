// Default land: `/` is a hop onto the person's most recent chat, or the
// new-chat composer when they have none. Home as a dashboard does not
// earn its keep — `/` only exists as this hop.

import { Button, EmptyState, PageShell } from "@corbits/react-ui";
import { WarningCircle } from "@/lib/icons";
import { useEffect, useState } from "react";

import { WorkbenchLoadingState } from "@/chat";
import { listChats } from "@/chat/threads-api";

import { useBench } from "../bench-context";
import { chatPath, NEW_CHAT_PATH } from "../chat-path";
import { useNavigate } from "../navigation";

export function HomeRoute() {
  const navigate = useNavigate();
  const { selectedTenantId, memberships } = useBench();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    void listChats(selectedTenantId).then(
      (chats) => {
        if (cancelled) return;
        const newest = chats[0];
        navigate(newest === undefined ? NEW_CHAT_PATH : chatPath(newest.id));
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, navigate]);

  if (memberships.kind === "loading") {
    return (
      <div className="page-fill shell-route-loading">
        <WorkbenchLoadingState />
      </div>
    );
  }

  if (memberships.kind === "error" || error !== null) {
    const message = memberships.kind === "error" ? memberships.message : (error ?? "");
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
