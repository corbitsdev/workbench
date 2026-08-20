// The "invite agent" affordance: a small dialog listing the tenant's
// deployed, launchable workflow definitions (never the workbench's own
// host — the server-side list already excludes it), each with an
// "Invite" action that launches it into the current workbench. The list
// itself carries its own loading/empty/error states since it is fetched
// fresh every time the dialog opens.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
} from "@corbits/react-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState } from "react";

import {
  ChatApiError,
  describeChatError,
  listInvitableDefinitions,
} from "./api";
import type { InvitableDefinition } from "./api";
import { CHAT_STRINGS } from "./strings";

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly InvitableDefinition[] };

export function InviteAgentDialog({
  open,
  onOpenChange,
  tenantId,
  workbenchId,
  onInvite,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tenantId: string;
  readonly workbenchId: string;
  readonly onInvite: (definitionId: string) => Promise<void>;
}) {
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [invitingId, setInvitingId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setState({ kind: "loading" });
    setInviteError(null);
    listInvitableDefinitions(tenantId, workbenchId)
      .then((items) => {
        if (!cancelled) setState({ kind: "ready", items });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: describeChatError(cause, "Couldn't load agents."),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId, workbenchId]);

  async function handleInvite(definitionId: string) {
    setInvitingId(definitionId);
    setInviteError(null);
    try {
      await onInvite(definitionId);
      onOpenChange(false);
    } catch (cause) {
      setInviteError(
        cause instanceof ChatApiError && cause.status === 409
          ? CHAT_STRINGS.inviteAgentConflictError
          : CHAT_STRINGS.inviteAgentInviteError,
      );
    } finally {
      setInvitingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent side="right">
        <DialogHeader>
          <DialogTitle>{CHAT_STRINGS.inviteAgentDialogTitle}</DialogTitle>
          <DialogDescription>
            {CHAT_STRINGS.inviteAgentDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {inviteError !== null && (
            <p className="chat-dialog-error" role="alert">
              {inviteError}
            </p>
          )}
          {state.kind === "loading" ? (
            <Skeleton className="query-skeleton" />
          ) : state.kind === "error" ? (
            <EmptyState
              icon={<CircleAlert />}
              title={CHAT_STRINGS.inviteAgentLoadError}
              description={state.message}
            />
          ) : state.items.length === 0 ? (
            <EmptyState
              icon={<Users />}
              title={CHAT_STRINGS.inviteAgentEmptyTitle}
              description={CHAT_STRINGS.inviteAgentEmptyDescription}
            />
          ) : (
            <ul className="chat-invitable-list">
              {state.items.map((definition) => (
                <li
                  key={definition.id}
                  className="chat-invitable-item"
                  data-testid="invitable-definition"
                >
                  <span>{definition.description ?? definition.name}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={invitingId !== null}
                    onClick={() => void handleInvite(definition.id)}
                  >
                    {invitingId === definition.id
                      ? CHAT_STRINGS.inviteAgentInviting
                      : CHAT_STRINGS.inviteAgentAction}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
