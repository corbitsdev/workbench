// CL-6628: flips the picker's hierarchy from "choose a kind, then create"
// to "say what you want, or choose a shortcut" — a prompt box is the
// primary act, with the prefab rows (still CL-6342/CL-6344's real
// instantiation paths) demoted to one-click shortcuts underneath. Typing
// a goal and hitting Enter creates a blank room and hands that text to
// `createWorkbenchFromTemplate` as `firstMessage`, so Myra's first read of
// the room is the person's actual intent rather than a kind label. A
// prefab click still creates immediately — no radio-then-Create
// second step anywhere on this screen.

import { Button, toast } from "@corbits/react-ui";
import { useDismissablePopover } from "@corbits/react-ui/hooks/use-dismissable-popover";
import {
  ChatCircle,
  GitPullRequest,
  MagnifyingGlass,
  PaperPlaneRight,
} from "@corbits/icons";
import {
  ChatApiError,
  CHAT_STRINGS,
  describeChatError,
  listTenantInvitableDefinitions,
  WorkbenchLoadingState,
  workbenchesQueryKeyPrefix,
} from "@corbits/chat-ui";
import { humanizeSlug } from "@corbits/chat/display-name";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getLogger } from "@corbits/client-log";
import { ApiQueryError, describeApiError } from "@corbits/api-query";
import { reportError } from "@corbits/error-sink";

import { useAPIQuery } from "../api";
import { TemplateLibraryPage } from "../workbench-templates-api";
import { useBench } from "../bench-context";
import {
  createWorkbenchFromTemplate,
  WorkbenchPostCreateError,
  WorkbenchPreconditionError,
} from "../instant-agent-create";
import { fetchAgentReadiness } from "../onboarding";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";
import {
  WORKBENCH_TEMPLATES,
  type WorkbenchTemplateId,
} from "../workbench-templates";

const log = getLogger("web.new-workbench-picker");

const GENERIC_CREATE_FAILURE =
  "Something went wrong creating this workbench. Try again.";

/**
 * Allow-lists what's safe to show verbatim, rather than denylisting
 * what to hide — a new error type `createWorkbenchFromTemplate`'s path
 * starts throwing later lands here unrecognized and falls to the
 * generic message, not into the toast raw. Only
 * `WorkbenchPreconditionError` carries authored, always-safe copy
 * ("try again" is a lie for a missing template, so its own message
 * says so instead); `ApiQueryError` and `ChatApiError` both embed raw
 * request paths and schema summaries in `.message` and must go through
 * their own describer, never shown directly.
 */
export function describeWorkbenchCreateFailure(
  cause: unknown,
  refId?: string,
): string {
  if (cause instanceof WorkbenchPostCreateError) {
    const message =
      cause.stage === "opening-message"
        ? "Workbench created, but we couldn't send the opening message or add the selected agent. Try again from the room."
        : "Workbench created, but we couldn't rename it.";
    return refId === undefined ? message : `${message} Reference: ${refId}`;
  }
  if (cause instanceof WorkbenchPreconditionError) return cause.message;
  if (cause instanceof ApiQueryError) {
    return describeApiError(cause, "creating this workbench");
  }
  if (cause instanceof ChatApiError) {
    return describeChatError(cause, GENERIC_CREATE_FAILURE);
  }
  return GENERIC_CREATE_FAILURE;
}

const CARD_ICON: Record<WorkbenchTemplateId, typeof GitPullRequest> = {
  "code-review": GitPullRequest,
  "due-diligence": MagnifyingGlass,
  blank: ChatCircle,
};

/** The one kind that needs no manifest: an empty room is always
 * something this bench can set up. */
const BLANK_TEMPLATE_ID: WorkbenchTemplateId = "blank";

const PROMPT_PLACEHOLDER = "What do you want your Workbench to do?";
const AGENT_LISTBOX_ID = "new-workbench-agent-listbox";

function agentDisplayName({
  name,
  description,
}: {
  readonly name: string;
  readonly description?: string;
}): string {
  return description ?? humanizeSlug(name);
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const library = useAPIQuery(
    selectedTenantId === null
      ? ""
      : `/api/tenants/${selectedTenantId}/library/templates`,
    TemplateLibraryPage,
  );
  const [prompt, setPrompt] = useState("");
  const [selectedAgentDefinitionIds, setSelectedAgentDefinitionIds] = useState<
    readonly string[]
  >([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState("");
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  // Set only when `createWorkbenchFromTemplate` hit the missing-setup-agent
  // precondition *and* a readiness check confirmed the bench genuinely
  // isn't chat-ready yet — never a guess from the error alone, since that
  // precondition is also what a template-that-will-never-exist looks like.
  // Distinct from `creating`'s loader: this is a dead end until setup
  // finishes, not a request in flight.
  const [stillSettingUp, setStillSettingUp] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const {
    rootRef: agentPickerRootRef,
    triggerRef: agentPickerTriggerRef,
    close: dismissAgentPicker,
  } = useDismissablePopover<HTMLDivElement, HTMLButtonElement>({
    closeOnEscape: false,
    open: agentPickerOpen,
    onOpenChange: setAgentPickerOpen,
  });
  const invitableAgents = useQuery({
    queryKey: ["tenant", selectedTenantId, "invitable-definitions"],
    queryFn: () => {
      if (selectedTenantId === null) {
        throw new Error("An account is required to load agents.");
      }
      return listTenantInvitableDefinitions(selectedTenantId);
    },
    enabled: selectedTenantId !== null,
  });
  // The last attempted create, so "Try again" (both the still-setting-up
  // dead end and a plain toast-and-retry) replays the exact same request
  // rather than silently falling back to blank.
  const lastAttemptRef = useRef<{
    readonly templateId: WorkbenchTemplateId;
    readonly firstMessage: string | undefined;
    readonly selectedIds: readonly string[];
  } | null>(null);

  // The prompt box only exists in the DOM once the library read settles
  // and neither dead-end state is showing — an unconditional mount-time
  // effect would fire while that branch renders `WorkbenchLoadingState`
  // instead, before `promptRef` has anything to focus. Re-running on
  // `showingPrompt` catches the moment the textarea actually mounts.
  const showingPrompt =
    !stillSettingUp && !creating && library.kind !== "loading";
  useEffect(() => {
    if (showingPrompt) promptRef.current?.focus();
  }, [showingPrompt]);

  useEffect(() => {
    setAgentPickerOpen(false);
    setAgentQuery("");
    setActiveAgentIndex(0);
    setSelectedAgentDefinitionIds([]);
  }, [selectedTenantId]);

  useEffect(() => {
    if (invitableAgents.data === undefined) return;
    const availableDefinitionIds = new Set(
      invitableAgents.data.map((agent) => agent.id),
    );
    setSelectedAgentDefinitionIds((current) => {
      const next = current.filter((id) => availableDefinitionIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [invitableAgents.data]);

  // What this bench's library can actually serve (CL-6458). A kind whose
  // manifest the library doesn't hold is shown as not set up rather than
  // offered and then dead-ended on a 404 at create time.
  const servedTemplateIds =
    library.kind === "ready"
      ? new Set(library.data.data.map((entry) => entry.id))
      : new Set<string>();
  const offeredTemplates = WORKBENCH_TEMPLATES.filter(
    (template) =>
      template.id !== BLANK_TEMPLATE_ID && servedTemplateIds.has(template.id),
  );
  const unavailableTemplates = WORKBENCH_TEMPLATES.filter(
    (template) =>
      template.id !== BLANK_TEMPLATE_ID && !offeredTemplates.includes(template),
  );
  const filteredAgents = (invitableAgents.data ?? []).filter((agent) => {
    const query = agentQuery.trim().toLocaleLowerCase();
    return (
      query === "" ||
      agentDisplayName(agent).toLocaleLowerCase().includes(query) ||
      agent.name.toLocaleLowerCase().includes(query)
    );
  });
  const selectedAgents = (invitableAgents.data ?? []).filter((agent) =>
    selectedAgentDefinitionIds.includes(agent.id),
  );

  async function handleCreate(
    templateId: WorkbenchTemplateId,
    firstMessage?: string,
    selectedIds: readonly string[] = [],
  ) {
    if (selectedTenantId === null || creating) return;
    lastAttemptRef.current = { templateId, firstMessage, selectedIds };
    setCreating(true);
    setStillSettingUp(false);
    try {
      await createWorkbenchFromTemplate(
        selectedTenantId,
        templateId,
        navigate,
        queryClient,
        firstMessage,
        selectedIds,
      );
    } catch (cause) {
      if (cause instanceof WorkbenchPostCreateError) {
        const refId = reportError(cause, {
          operation: "workbench_post_create",
          tenantId: selectedTenantId,
          roomId: cause.workbenchId,
          extra: { stage: cause.stage },
        });
        await queryClient.invalidateQueries({
          queryKey: workbenchesQueryKeyPrefix(selectedTenantId),
        });
        navigate(workbenchPath(cause.workbenchId));
        toast(describeWorkbenchCreateFailure(cause, refId));
        return;
      }
      // The missing-setup-agent precondition reads identically whether
      // this bench's default agents never finished deploying (CL-6457's
      // background drain is still running, or never started without a
      // credential) or something is genuinely broken. Only a readiness
      // check tells those apart — never assume from the throw alone.
      if (
        cause instanceof WorkbenchPreconditionError &&
        cause.kind === "setup-agent-missing"
      ) {
        const readiness = await fetchAgentReadiness();
        if (readiness.kind !== "ready" && readiness.kind !== "chat-ready") {
          setCreating(false);
          setStillSettingUp(true);
          return;
        }
      }
      log.error("Couldn't create the workbench", {
        message: cause instanceof Error ? cause.message : String(cause),
        status:
          cause instanceof ApiQueryError || cause instanceof ChatApiError
            ? cause.status
            : undefined,
        path: cause instanceof ApiQueryError ? cause.path : undefined,
      });
      toast(describeWorkbenchCreateFailure(cause));
      setCreating(false);
    }
  }

  function retryLastAttempt() {
    const attempt = lastAttemptRef.current;
    if (attempt === null) return;
    void handleCreate(
      attempt.templateId,
      attempt.firstMessage,
      attempt.selectedIds,
    );
  }

  function handlePromptSubmit() {
    const trimmed = prompt.trim();
    if (trimmed === "") return;
    void handleCreate(BLANK_TEMPLATE_ID, trimmed, selectedAgentDefinitionIds);
  }

  function toggleAgent(definitionId: string) {
    setSelectedAgentDefinitionIds((current) =>
      current.includes(definitionId)
        ? current.filter((id) => id !== definitionId)
        : [...current, definitionId],
    );
  }

  function closeAgentPicker() {
    setAgentQuery("");
    setActiveAgentIndex(0);
    dismissAgentPicker();
  }

  function openAgentPicker() {
    setAgentPickerOpen(true);
    setAgentQuery("");
    setActiveAgentIndex(0);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: CHAT_STRINGS.newWorkbenchAction }]}
        actions={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => navigate("/")}
          >
            Cancel
          </Button>
        }
      />
      <div className="new-workbench-picker">
        {stillSettingUp ? (
          <div className="new-workbench-picker-not-ready">
            <h3>Still setting up your workbench</h3>
            <p className="new-workbench-picker-sub">
              Your account&apos;s agents are finishing setup in the background.
              This usually takes under a minute — try again in a moment.
            </p>
            <Button type="button" variant="outline" onClick={retryLastAttempt}>
              Try again
            </Button>
          </div>
        ) : creating ? (
          // `delayMs={0}`: we already know this is a genuine wait the
          // instant the person hits Enter or clicks a card, so the default
          // "hold back briefly in case it resolves fast" delay only bought
          // a blank pane here (CL-6623 finding #3) — show the loader
          // outright instead of leaving a gap before it mounts.
          <WorkbenchLoadingState
            delayMs={0}
            title="Setting up your workbench…"
          />
        ) : library.kind === "loading" ? (
          <WorkbenchLoadingState title="Seeing what you can set up here…" />
        ) : (
          <>
            <h3>What do you want your Workbench to do?</h3>
            <p className="new-workbench-picker-sub">
              Tell it what you're trying to get done, or pick one below. Takes
              about ten seconds.
            </p>

            <form
              className="new-workbench-prompt"
              onSubmit={(event) => {
                event.preventDefault();
                handlePromptSubmit();
              }}
            >
              <div className="new-workbench-prompt-main">
                <textarea
                  ref={promptRef}
                  className="new-workbench-prompt-input"
                  placeholder={PROMPT_PLACEHOLDER}
                  value={prompt}
                  rows={2}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      handlePromptSubmit();
                    }
                  }}
                />
                <div
                  className="new-workbench-prompt-examples"
                  aria-label="Try an example"
                >
                  <span>Try</span>
                  {[
                    "Review every PR on faremeter/interchange",
                    "Vet Northwind Traders before we sign",
                    "Summarize what shipped each Friday",
                  ].map((example) => (
                    <button
                      key={example}
                      type="button"
                      onClick={() => setPrompt(example)}
                    >
                      {example}
                    </button>
                  ))}
                </div>
              </div>
              <div className="new-workbench-prompt-actions">
                <div className="new-workbench-agent-selection">
                  <span>In the room</span>
                  {selectedAgents.map((agent) => (
                    <span key={agent.id} className="new-workbench-agent-chip">
                      {agentDisplayName(agent)}
                      <button
                        type="button"
                        aria-label={`Remove ${agentDisplayName(agent)}`}
                        onClick={() => toggleAgent(agent.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {invitableAgents.isLoading ? (
                    <span className="new-workbench-agent-status">
                      Loading agents…
                    </span>
                  ) : invitableAgents.isError ? (
                    <span className="new-workbench-agent-status" role="status">
                      Couldn&apos;t load agents. You can still start without
                      one.
                    </span>
                  ) : invitableAgents.data?.length === 0 ? (
                    <span className="new-workbench-agent-status">
                      No agents are available yet.
                    </span>
                  ) : (
                    <div
                      ref={agentPickerRootRef}
                      className="new-workbench-agent-picker"
                    >
                      <button
                        ref={agentPickerTriggerRef}
                        type="button"
                        className="new-workbench-add-agent"
                        aria-controls={AGENT_LISTBOX_ID}
                        aria-expanded={agentPickerOpen}
                        onClick={() =>
                          agentPickerOpen
                            ? closeAgentPicker()
                            : openAgentPicker()
                        }
                      >
                        + Add agent
                      </button>
                      {agentPickerOpen ? (
                        <div className="new-workbench-agent-popover">
                          <input
                            autoFocus
                            className="new-workbench-agent-search"
                            type="search"
                            placeholder="Find an agent…"
                            value={agentQuery}
                            role="combobox"
                            aria-autocomplete="list"
                            aria-controls={AGENT_LISTBOX_ID}
                            aria-expanded="true"
                            aria-activedescendant={
                              filteredAgents[activeAgentIndex] === undefined
                                ? undefined
                                : `new-workbench-agent-${filteredAgents[activeAgentIndex].id}`
                            }
                            onChange={(event) => {
                              setAgentQuery(event.target.value);
                              setActiveAgentIndex(0);
                            }}
                            onKeyDown={(event) => {
                              if (event.key === "ArrowDown") {
                                event.preventDefault();
                                setActiveAgentIndex((current) =>
                                  Math.min(
                                    current + 1,
                                    filteredAgents.length - 1,
                                  ),
                                );
                              }
                              if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveAgentIndex((current) =>
                                  Math.max(current - 1, 0),
                                );
                              }
                              if (event.key === "Enter") {
                                const activeAgent =
                                  filteredAgents[activeAgentIndex];
                                if (activeAgent !== undefined) {
                                  event.preventDefault();
                                  toggleAgent(activeAgent.id);
                                }
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                closeAgentPicker();
                              }
                            }}
                          />
                          {filteredAgents.length === 0 ? (
                            <p className="new-workbench-agent-empty">
                              No agents match that search.
                            </p>
                          ) : (
                            <div
                              id={AGENT_LISTBOX_ID}
                              role="listbox"
                              aria-label="Available agents"
                            >
                              {filteredAgents.map((agent, index) => {
                                const selected =
                                  selectedAgentDefinitionIds.includes(agent.id);
                                return (
                                  <button
                                    key={agent.id}
                                    id={`new-workbench-agent-${agent.id}`}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    className={
                                      index === activeAgentIndex
                                        ? "new-workbench-agent-option is-active"
                                        : "new-workbench-agent-option"
                                    }
                                    onMouseMove={() =>
                                      setActiveAgentIndex(index)
                                    }
                                    onClick={() => toggleAgent(agent.id)}
                                  >
                                    <span className="new-workbench-agent-option-name">
                                      {agentDisplayName(agent)}
                                    </span>
                                    <span className="new-workbench-agent-option-handle">
                                      {agent.name}
                                    </span>
                                    {selected ? (
                                      <span aria-hidden="true">✓</span>
                                    ) : null}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
                <span className="new-workbench-enter-hint">↵ Enter</span>
                <Button
                  type="submit"
                  aria-label="Start this workbench"
                  disabled={prompt.trim() === "" || selectedTenantId === null}
                >
                  Start
                  <PaperPlaneRight size={16} strokeWidth={1.8} />
                </Button>
              </div>
            </form>

            {library.kind === "error" ? (
              <p className="new-workbench-picker-sub" role="status">
                Couldn't load what this bench can set up, so only a plain room
                is on offer right now.{" "}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => library.retry()}
                >
                  Try again
                </Button>
              </p>
            ) : null}

            <div className="new-workbench-template-heading">
              <span>Or start from a template</span>
              <span>Agents are already in the room. One click opens it.</span>
            </div>
            <div className="new-workbench-prefab-grid">
              {offeredTemplates.map((template) => {
                const Icon = CARD_ICON[template.id];
                return (
                  <button
                    key={template.id}
                    type="button"
                    className="new-workbench-prefab-card"
                    disabled={creating || selectedTenantId === null}
                    onClick={() => void handleCreate(template.id)}
                  >
                    <span
                      className="new-workbench-pick-glyph"
                      aria-hidden="true"
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span className="new-workbench-pick-text">
                      <span className="new-workbench-pick-title">
                        {template.title}
                      </span>
                      <span className="new-workbench-pick-promise">
                        {template.promise}
                      </span>
                    </span>
                  </button>
                );
              })}

              {unavailableTemplates.map((template) => {
                const Icon = CARD_ICON[template.id];
                return (
                  <span
                    key={template.id}
                    className="new-workbench-prefab-card"
                    aria-disabled="true"
                  >
                    <span
                      className="new-workbench-pick-glyph"
                      aria-hidden="true"
                    >
                      <Icon size={16} strokeWidth={1.8} />
                    </span>
                    <span className="new-workbench-pick-text">
                      <span className="new-workbench-pick-title">
                        {template.title}
                      </span>
                      <span className="new-workbench-pick-promise">
                        Not set up on this bench yet.
                      </span>
                    </span>
                  </span>
                );
              })}
            </div>
            <button
              type="button"
              className="new-workbench-empty-channel"
              disabled={creating || selectedTenantId === null}
              onClick={() => void handleCreate(BLANK_TEMPLATE_ID)}
            >
              Or <span>just open an empty channel</span> — nobody is in it yet,
              add people and agents as you go.
            </button>
          </>
        )}
      </div>
    </div>
  );
}
