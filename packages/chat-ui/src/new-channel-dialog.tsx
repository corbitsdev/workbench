// The "new channel"/"new chat" affordance, behind a small centered dialog
// triggered from the sidebar. A channel is name-only; a chat additionally
// requires picking exactly one agent (a radio list of the tenant's
// invitable definitions, by name only — the definition id stays internal)
// since a chat's agent is fixed at creation and can never be invited into
// afterward.

import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  Skeleton,
} from "@corbits/react-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  CreateChannelInput,
  ChannelKind,
  InvitableDefinition,
} from "./api";
import { listInvitableDefinitions } from "./api";
import { CHAT_STRINGS } from "./strings";

// The invitable-definitions listing is fetched per-channel in the invite
// flow, but the underlying tenant-wide listing does not actually key off
// the channel id (see `packages/chat/src/routes.ts`'s `/channels/:id/invitable`
// handler) — so this placeholder segment is enough to reuse it before a
// chat (and its id) exists yet.
const NEW_CHAT_PLACEHOLDER_CHANNEL_ID = "new";

type AgentListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly InvitableDefinition[] };

/**
 * Whether the form has enough to submit: a channel needs a name; a chat
 * needs an agent picked (its name is optional — the server falls back to
 * the agent's handle).
 */
export function canSubmitNewChannel(
  kind: ChannelKind,
  name: string,
  definitionId: string | null,
): boolean {
  return kind === "channel" ? name.trim().length > 0 : definitionId !== null;
}

/**
 * The exact `CreateChannelInput` this form would submit, or `null` if it
 * isn't ready to (mirrors `canSubmitNewChannel`). A chat's name is only
 * ever sent when the person actually typed one — the client never guesses
 * a name on the agent's behalf; that fallback is the server's to make.
 */
export function newChannelPayload(
  kind: ChannelKind,
  name: string,
  definitionId: string | null,
): CreateChannelInput | null {
  const trimmed = name.trim();
  if (kind === "channel") {
    return trimmed.length === 0 ? null : { kind: "channel", name: trimmed };
  }
  if (definitionId === null) return null;
  return trimmed.length === 0
    ? { kind: "chat", definitionId }
    : { kind: "chat", definitionId, name: trimmed };
}

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreate,
  tenantId,
  submitting,
  error = null,
  initialKind = "channel",
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: CreateChannelInput) => void;
  readonly tenantId: string;
  readonly submitting: boolean;
  readonly error?: string | null;
  /** Which kind the radio starts on — a bench with only chats, say, could open this straight to "chat". */
  readonly initialKind?: ChannelKind;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>(initialKind);
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentListState>({
    kind: "loading",
  });

  function reset() {
    setName("");
    setKind(initialKind);
    setDefinitionId(null);
  }

  useEffect(() => {
    if (!open || kind !== "chat") return;
    let cancelled = false;
    setAgentState({ kind: "loading" });
    listInvitableDefinitions(tenantId, NEW_CHAT_PLACEHOLDER_CHANNEL_ID)
      .then((items) => {
        if (!cancelled) setAgentState({ kind: "ready", items });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setAgentState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, tenantId]);

  const canSubmit = canSubmitNewChannel(kind, name, definitionId);

  function handleSubmit() {
    const payload = newChannelPayload(kind, name, definitionId);
    if (payload !== null) onCreate(payload);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "chat"
              ? CHAT_STRINGS.newChatDialogTitle
              : CHAT_STRINGS.newChannelDialogTitle}
          </DialogTitle>
          <DialogDescription>
            {kind === "chat"
              ? CHAT_STRINGS.newChatDialogDescription
              : CHAT_STRINGS.newChannelDialogDescription}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="new-channel-form"
            className="chat-new-channel-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <fieldset className="chat-form-field">
              <legend>{CHAT_STRINGS.newChannelKindLabel}</legend>
              <label className="chat-radio-option">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === "channel"}
                  onChange={() => setKind("channel")}
                />
                {CHAT_STRINGS.newChannelKindChannel}
              </label>
              <label className="chat-radio-option">
                <input
                  type="radio"
                  name="kind"
                  checked={kind === "chat"}
                  onChange={() => setKind("chat")}
                />
                {CHAT_STRINGS.newChannelKindChat}
              </label>
            </fieldset>
            {kind === "chat" ? (
              <fieldset
                className="chat-form-field"
                data-testid="new-chat-agent-picker"
              >
                <legend>{CHAT_STRINGS.newChatAgentLabel}</legend>
                {agentState.kind === "loading" ? (
                  <Skeleton className="query-skeleton" />
                ) : agentState.kind === "error" ? (
                  <EmptyState
                    icon={<CircleAlert />}
                    title={CHAT_STRINGS.newChatAgentLoadError}
                    description={agentState.message}
                  />
                ) : agentState.items.length === 0 ? (
                  <EmptyState
                    icon={<Users />}
                    title={CHAT_STRINGS.newChatAgentEmptyTitle}
                    description={CHAT_STRINGS.newChatAgentEmptyDescription}
                  />
                ) : (
                  agentState.items.map((definition) => (
                    <label
                      key={definition.id}
                      className="chat-radio-option"
                      data-testid="new-chat-agent-option"
                    >
                      <input
                        type="radio"
                        name="agent"
                        checked={definitionId === definition.id}
                        onChange={() => setDefinitionId(definition.id)}
                      />
                      {definition.name}
                    </label>
                  ))
                )}
              </fieldset>
            ) : null}
            <label className="chat-form-field">
              <span>
                {kind === "chat"
                  ? CHAT_STRINGS.newChatNameLabel
                  : CHAT_STRINGS.newChannelNameLabel}
              </span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={
                  kind === "chat"
                    ? CHAT_STRINGS.newChatNamePlaceholder
                    : CHAT_STRINGS.newChannelNamePlaceholder
                }
                autoFocus={kind === "channel"}
              />
            </label>
            {error !== null && (
              <p className="chat-dialog-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {CHAT_STRINGS.newChannelCancel}
          </Button>
          <Button
            type="submit"
            form="new-channel-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {CHAT_STRINGS.newChannelSubmit}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
