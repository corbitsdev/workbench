// The "new channel"/"new chat" affordance, behind a small centered dialog
// triggered from the sidebar, walked as a two-step guided flow: pick a kind,
// then fill in that kind's (few) details. A channel is name-only; a chat
// additionally requires picking exactly one counterpart — an agent (a radio
// list of the tenant's invitable definitions, by name only — the definition
// id stays internal) or a bench member (a radio list of the bench's people,
// sourced the same way Settings → People is) — since a chat's counterpart is
// fixed at creation and can never be invited into afterward. A caller that
// already knows the kind (`initialKind`) skips the kind step entirely and
// opens straight on details.

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
  Tabs,
} from "@corbits/react-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  CreateChannelInput,
  ChannelKind,
  InvitableDefinition,
} from "./api";
import { listInvitableDefinitions } from "./api";
import { DialogStepper } from "./dialog-stepper";
import type { DialogStepperStep } from "./dialog-stepper";
import { CHAT_STRINGS } from "./strings";

type NewChannelStep = 1 | 2;

// The invitable-definitions listing is fetched per-channel in the invite
// flow, but the underlying tenant-wide listing does not actually key off
// the channel id (see `packages/chat/src/routes.ts`'s `/channels/:id/invitable`
// handler) — so this placeholder segment is enough to reuse it before a
// chat (and its id) exists yet.
const NEW_CHAT_PLACEHOLDER_CHANNEL_ID = "new";

/**
 * A bench member a chat's counterpart can be — the same People listing
 * Settings → People renders, reduced to the two fields this dialog needs.
 * `chat-ui` owns no session or tenancy client of its own (see
 * `chat-workspace.tsx`'s module note), so this is injected via
 * `listMembers`, the same host-props pattern `ChatWorkspace` already uses
 * for `currentUser`/`tenant`.
 */
export interface PersonOption {
  readonly id: string;
  readonly displayName: string;
}

type AgentListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly InvitableDefinition[] };

type PersonListState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly PersonOption[] };

type CounterpartTab = "agent" | "person";

/**
 * A chat's counterpart — exactly one agent or one bench member, never
 * both. The person branch carries `displayName` along so the payload can
 * default the chat's title to it without a second server round trip (see
 * `newChannelPayload`) — the server has no identity resolution of its own
 * to fall back on for a person the way it does an agent's definition name.
 */
export type ChatCounterpart =
  | { readonly kind: "agent"; readonly definitionId: string }
  | {
      readonly kind: "person";
      readonly principalId: string;
      readonly displayName: string;
    };

/**
 * Whether the form has enough to submit: a channel needs a name; a chat
 * needs a counterpart picked (its name is optional — the server falls back
 * to the agent's handle, and this dialog itself always supplies a person's
 * display name as the fallback title — see `newChannelPayload`).
 */
export function canSubmitNewChannel(
  kind: ChannelKind,
  name: string,
  counterpart: ChatCounterpart | null,
): boolean {
  return kind === "channel" ? name.trim().length > 0 : counterpart !== null;
}

/**
 * The exact `CreateChannelInput` this form would submit, or `null` if it
 * isn't ready to (mirrors `canSubmitNewChannel`). A channel's name is only
 * ever sent when the person actually typed one. An agent chat's name is the
 * same — the client never guesses a name on the agent's behalf, that
 * fallback is the server's to make. A person chat is different: this
 * dialog already knows the chosen member's display name (it fetched the
 * list to render), so it always sends a title, defaulting to that name
 * rather than leaving the server to fall back to the bare principal id.
 */
export function newChannelPayload(
  kind: ChannelKind,
  name: string,
  counterpart: ChatCounterpart | null,
): CreateChannelInput | null {
  const trimmed = name.trim();
  if (kind === "channel") {
    return trimmed.length === 0 ? null : { kind: "channel", name: trimmed };
  }
  if (counterpart === null) return null;
  if (counterpart.kind === "agent") {
    return trimmed.length === 0
      ? { kind: "chat", definitionId: counterpart.definitionId }
      : {
          kind: "chat",
          definitionId: counterpart.definitionId,
          name: trimmed,
        };
  }
  return {
    kind: "chat",
    principalId: counterpart.principalId,
    name: trimmed.length === 0 ? counterpart.displayName : trimmed,
  };
}

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreate,
  tenantId,
  submitting,
  error = null,
  initialKind,
  listMembers,
  currentUserPrincipalId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * `purpose` is only passed for a channel that was given one — a chat has
   * no purpose field at all, and an empty channel purpose is the same as
   * not typing one. `POST /channels` doesn't accept a `purpose` field (see
   * `packages/chat/src/routes.ts`), so a caller that wants it persisted
   * follows up with a `chat/purpose` settings PATCH once the channel
   * exists — see `ChatWorkspace.handleCreateChannel`.
   */
  readonly onCreate: (input: CreateChannelInput, purpose?: string) => void;
  readonly tenantId: string;
  readonly submitting: boolean;
  readonly error?: string | null;
  /**
   * The kind the dialog already knows, e.g. a "New chat" affordance that
   * only ever creates chats. When given, the guided flow skips its own
   * kind-picking step and opens straight on that kind's details — omit it
   * for a general "New channel" entry point that should ask first.
   */
  readonly initialKind?: ChannelKind;
  /**
   * The bench's people, sourced the same way Settings → People is —
   * host-supplied, since this package resolves neither sessions nor
   * tenancy. Omitted entirely, the People tab does not render at all: a
   * host that hasn't wired a member directory yet gets the agent-only
   * dialog this always used to be, never a tab that silently fails to load.
   */
  readonly listMembers?: (tenantId: string) => Promise<readonly PersonOption[]>;
  /** Excluded from the People list — starting a direct chat with yourself
   * is refused by the server (409), so this dialog never offers it. */
  readonly currentUserPrincipalId?: string;
}) {
  // A caller that already knows the kind opens straight on the details
  // step — `initialKind` is only ever passed by a caller in that position,
  // so its mere presence (not its value) is the "skip the kind step" signal.
  const startStep: NewChannelStep = initialKind === undefined ? 1 : 2;
  const resolvedInitialKind = initialKind ?? "channel";

  const [step, setStep] = useState<NewChannelStep>(startStep);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [kind, setKind] = useState<ChannelKind>(resolvedInitialKind);
  const [counterpartTab, setCounterpartTab] = useState<CounterpartTab>("agent");
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [personId, setPersonId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<AgentListState>({
    kind: "loading",
  });
  const [personState, setPersonState] = useState<PersonListState>({
    kind: "loading",
  });

  function reset() {
    setStep(startStep);
    setName("");
    setPurpose("");
    setKind(resolvedInitialKind);
    setCounterpartTab("agent");
    setDefinitionId(null);
    setPersonId(null);
  }

  useEffect(() => {
    if (!open || kind !== "chat" || counterpartTab !== "agent") return;
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
  }, [open, kind, counterpartTab, tenantId]);

  useEffect(() => {
    if (
      !open ||
      kind !== "chat" ||
      counterpartTab !== "person" ||
      listMembers === undefined
    ) {
      return;
    }
    let cancelled = false;
    setPersonState({ kind: "loading" });
    listMembers(tenantId)
      .then((items) => {
        if (!cancelled) {
          setPersonState({
            kind: "ready",
            items: items.filter(
              (person) => person.id !== currentUserPrincipalId,
            ),
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPersonState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    kind,
    counterpartTab,
    listMembers,
    tenantId,
    currentUserPrincipalId,
  ]);

  const counterpart: ChatCounterpart | null =
    counterpartTab === "agent"
      ? definitionId !== null
        ? { kind: "agent", definitionId }
        : null
      : personState.kind === "ready" && personId !== null
        ? {
            kind: "person",
            principalId: personId,
            displayName:
              personState.items.find((person) => person.id === personId)
                ?.displayName ?? personId,
          }
        : null;

  const canSubmit = canSubmitNewChannel(kind, name, counterpart);

  function handleSubmit() {
    const payload = newChannelPayload(kind, name, counterpart);
    if (payload === null) return;
    const trimmedPurpose = purpose.trim();
    onCreate(
      payload,
      kind === "channel" && trimmedPurpose.length > 0
        ? trimmedPurpose
        : undefined,
    );
  }

  const stepperSteps: readonly DialogStepperStep[] = [
    {
      label: CHAT_STRINGS.newChannelStepKindLabel,
      guidance: CHAT_STRINGS.newChannelStepKindGuidance,
    },
    {
      label: CHAT_STRINGS.newChannelStepDetailsLabel,
      guidance:
        kind === "chat"
          ? CHAT_STRINGS.newChannelStepChatGuidance
          : CHAT_STRINGS.newChannelStepChannelGuidance,
    },
  ];

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
          <DialogStepper step={step} steps={stepperSteps} />
          <form
            id="new-channel-form"
            className="chat-new-channel-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (step === 1) {
                setStep(2);
                return;
              }
              handleSubmit();
            }}
          >
            {step === 1 ? (
              <div className="chat-form-field">
                <span className="chat-field-label">
                  {CHAT_STRINGS.newChannelKindLabel}
                </span>
                <div
                  role="group"
                  aria-label={CHAT_STRINGS.newChannelKindLabel}
                  className="chat-kind-grid"
                >
                  <button
                    type="button"
                    className="chat-kind-card"
                    aria-pressed={kind === "channel"}
                    onClick={() => setKind("channel")}
                  >
                    <span className="chat-kind-card-title">
                      {CHAT_STRINGS.newChannelKindChannel}
                    </span>
                    <span className="chat-kind-card-desc">
                      {CHAT_STRINGS.newChannelKindChannelDesc}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="chat-kind-card"
                    aria-pressed={kind === "chat"}
                    onClick={() => setKind("chat")}
                  >
                    <span className="chat-kind-card-title">
                      {CHAT_STRINGS.newChannelKindChat}
                    </span>
                    <span className="chat-kind-card-desc">
                      {CHAT_STRINGS.newChannelKindChatDesc}
                    </span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                {kind === "chat" ? (
                  <div
                    className="chat-form-field"
                    data-testid="new-chat-counterpart-picker"
                  >
                    {listMembers !== undefined ? (
                      <Tabs<CounterpartTab>
                        tabs={[
                          {
                            id: "agent",
                            label: CHAT_STRINGS.newChatCounterpartTabAgent,
                          },
                          {
                            id: "person",
                            label: CHAT_STRINGS.newChatCounterpartTabPerson,
                          },
                        ]}
                        active={counterpartTab}
                        onChange={setCounterpartTab}
                        label={CHAT_STRINGS.newChatDialogTitle}
                        variant="enclosed"
                      >
                        {(active) =>
                          active === "agent" ? (
                            <AgentPicker
                              state={agentState}
                              selectedId={definitionId}
                              onSelect={setDefinitionId}
                            />
                          ) : (
                            <PersonPicker
                              state={personState}
                              selectedId={personId}
                              onSelect={setPersonId}
                            />
                          )
                        }
                      </Tabs>
                    ) : (
                      <fieldset data-testid="new-chat-agent-picker">
                        <legend className="chat-field-label">
                          {CHAT_STRINGS.newChatAgentLabel}
                        </legend>
                        <AgentPicker
                          state={agentState}
                          selectedId={definitionId}
                          onSelect={setDefinitionId}
                        />
                      </fieldset>
                    )}
                  </div>
                ) : null}
                <label className="chat-form-field">
                  <span className="chat-field-label">
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
                {kind === "channel" ? (
                  <label className="chat-form-field">
                    <span className="chat-field-label">
                      {CHAT_STRINGS.newChannelPurposeLabel}
                    </span>
                    <textarea
                      className="chat-textarea"
                      value={purpose}
                      onChange={(event) => setPurpose(event.target.value)}
                      placeholder={CHAT_STRINGS.newChannelPurposePlaceholder}
                      rows={2}
                    />
                  </label>
                ) : null}
              </>
            )}
            {error !== null && (
              <p className="chat-dialog-error" role="alert">
                {error}
              </p>
            )}
          </form>
        </DialogBody>
        <DialogFooter>
          {step === 2 && startStep === 1 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep(1)}
              disabled={submitting}
            >
              {CHAT_STRINGS.newChannelBack}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {CHAT_STRINGS.newChannelCancel}
          </Button>
          {step === 1 ? (
            <Button type="submit" form="new-channel-form" variant="primary">
              {CHAT_STRINGS.newChannelNext}
            </Button>
          ) : (
            <Button
              type="submit"
              form="new-channel-form"
              variant="primary"
              disabled={!canSubmit || submitting}
            >
              {submitting
                ? CHAT_STRINGS.newChannelSubmitting
                : CHAT_STRINGS.newChannelSubmit}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AgentPicker({
  state,
  selectedId,
  onSelect,
}: {
  readonly state: AgentListState;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={CHAT_STRINGS.newChatAgentLoadError}
        description={state.message}
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title={CHAT_STRINGS.newChatAgentEmptyTitle}
        description={CHAT_STRINGS.newChatAgentEmptyDescription}
      />
    );
  }
  return (
    <>
      {state.items.map((definition) => (
        <label
          key={definition.id}
          className="chat-radio-option"
          data-testid="new-chat-agent-option"
        >
          <input
            type="radio"
            name="counterpart-agent"
            checked={selectedId === definition.id}
            onChange={() => onSelect(definition.id)}
          />
          {definition.name}
        </label>
      ))}
    </>
  );
}

function PersonPicker({
  state,
  selectedId,
  onSelect,
}: {
  readonly state: PersonListState;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title={CHAT_STRINGS.newChatPersonLoadError}
        description={state.message}
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title={CHAT_STRINGS.newChatPersonEmptyTitle}
        description={CHAT_STRINGS.newChatPersonEmptyDescription}
      />
    );
  }
  return (
    <>
      {state.items.map((person) => (
        <label
          key={person.id}
          className="chat-radio-option"
          data-testid="new-chat-person-option"
        >
          <input
            type="radio"
            name="counterpart-person"
            checked={selectedId === person.id}
            onChange={() => onSelect(person.id)}
          />
          {person.displayName}
        </label>
      ))}
    </>
  );
}
