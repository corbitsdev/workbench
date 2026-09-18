// workbench template picking is gone — a new workbench is a
// plain tenant + Myra (its converge path deploys Myra behind the
// scenes). This screen is just the prompt box: say what you want and hit
// Enter, or open an empty channel and add people/agents as you go.

import { Button, toast } from "@corbits/react-ui";
import { useDismissablePopover } from "@corbits/react-ui/hooks/use-dismissable-popover";
import { PaperPlaneRight } from "@/lib/icons";
import {
  ChatApiError,
  CHAT_STRINGS,
  describeChatError,
  listTenantInvitableDefinitions,
  WorkbenchLoadingState,
} from "@/chat";
import { humanizeSlug } from "@/chat/wire/display-name";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiQueryError, describeApiError } from "@/lib/api-query";
import { reportError } from "@corbits/error-sink";

import { CreateAgentPanel } from "./create-agent-panel";
import { getAgentRun } from "../agents-api";
import { useBench } from "../bench-context";
import {
  createWorkbench,
  refreshWorkbenchLists,
  WorkbenchPostCreateError,
  WorkbenchPreconditionError,
} from "../instant-agent-create";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";

const GENERIC_CREATE_FAILURE = "Something went wrong creating this workbench. Try again.";

/**
 * Allow-lists what's safe to show verbatim, rather than denylisting
 * what to hide — a new error type `createWorkbench`'s path starts
 * throwing later lands here unrecognized and falls to the generic
 * message, not into the toast raw. Only `WorkbenchPreconditionError`
 * carries authored, always-safe copy; `ApiQueryError` and `ChatApiError`
 * both embed raw request paths and schema summaries in `.message` and
 * must go through their own describer, never shown directly.
 */
export function describeWorkbenchCreateFailure(cause: unknown, refId?: string): string {
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

const PROMPT_PLACEHOLDER = "What do you want your Workbench to do?";
const AGENT_LISTBOX_ID = "new-workbench-agent-listbox";

function agentDisplayName({
  name,
  description,
}: {
  readonly name: string;
  readonly description?: string;
}): string {
  return description === undefined || description === "" ? humanizeSlug(name) : description;
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const currentTenantIdRef = useRef(selectedTenantId);
  useEffect(() => {
    currentTenantIdRef.current = selectedTenantId;
    return () => {
      currentTenantIdRef.current = null;
    };
  }, [selectedTenantId]);
  const [prompt, setPrompt] = useState("");
  const [selectedAgentDefinitionIds, setSelectedAgentDefinitionIds] = useState<readonly string[]>(
    [],
  );
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState("");
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  // Set only when `createWorkbench` hit the missing-setup-agent
  // precondition — thrown only after its own native definitions read found
  // no setup agent, so that read is the readiness check, never a guess
  // from the error alone. Distinct from `creating`'s loader: this is a
  // dead end until setup finishes, not a request in flight.
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
    readonly firstMessage: string | undefined;
    readonly selectedIds: readonly string[];
  } | null>(null);

  // The prompt box only exists in the DOM once neither dead-end state is
  // showing — an unconditional mount-time effect would fire while a dead
  // end renders instead, before `promptRef` has anything to focus.
  const showingPrompt = !stillSettingUp && !creating;
  useEffect(() => {
    if (showingPrompt) promptRef.current?.focus();
  }, [showingPrompt]);

  useEffect(() => {
    setAgentPickerOpen(false);
    setCreateAgentOpen(false);
    setAgentQuery("");
    setActiveAgentIndex(0);
    setSelectedAgentDefinitionIds([]);
  }, [selectedTenantId]);

  useEffect(() => {
    if (invitableAgents.data === undefined) return;
    const availableDefinitionIds = new Set(invitableAgents.data.map((agent) => agent.id));
    setSelectedAgentDefinitionIds((current) => {
      const next = current.filter((id) => availableDefinitionIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [invitableAgents.data]);

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

  async function handleCreate(firstMessage?: string, selectedIds: readonly string[] = []) {
    if (selectedTenantId === null || creating) return;
    lastAttemptRef.current = { firstMessage, selectedIds };
    setCreating(true);
    setStillSettingUp(false);
    try {
      await createWorkbench(selectedTenantId, navigate, queryClient, firstMessage, selectedIds);
    } catch (cause) {
      if (cause instanceof WorkbenchPostCreateError) {
        const refId = reportError(cause, {
          operation: "workbench_post_create",
          tenantId: selectedTenantId,
          roomId: cause.workbenchId,
          extra: { stage: cause.stage },
        });
        refreshWorkbenchLists(queryClient, selectedTenantId, cause.workbenchId);
        navigate(workbenchPath(cause.workbenchId));
        toast(describeWorkbenchCreateFailure(cause, refId));
        return;
      }
      if (cause instanceof WorkbenchPreconditionError && cause.kind === "setup-agent-missing") {
        setCreating(false);
        setStillSettingUp(true);
        return;
      }
      // Every remaining cause is a genuinely failed create: report it with
      // operation context and a quotable refId rather than a log line alone.
      const refId = reportError(cause, {
        operation: "workbench_create",
        tenantId: selectedTenantId,
      });
      toast(describeWorkbenchCreateFailure(cause, refId));
      setCreating(false);
    }
  }

  function retryLastAttempt() {
    const attempt = lastAttemptRef.current;
    if (attempt === null) return;
    void handleCreate(attempt.firstMessage, attempt.selectedIds);
  }

  function handlePromptSubmit() {
    const trimmed = prompt.trim();
    if (trimmed === "") return;
    void handleCreate(trimmed, selectedAgentDefinitionIds);
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
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/")}>
            Cancel
          </Button>
        }
      />
      <div className="new-workbench-picker">
        {stillSettingUp ? (
          <div className="new-workbench-picker-not-ready">
            <h3>Still setting up your workbench</h3>
            <p className="new-workbench-picker-sub">
              Your account&apos;s agents are finishing setup in the background. This usually takes
              under a minute — try again in a moment.
            </p>
            <Button type="button" variant="outline" onClick={retryLastAttempt}>
              Try again
            </Button>
          </div>
        ) : creating ? (
          // `delayMs={0}`: we already know this is a genuine wait the
          // instant the person hits Enter, so the default "hold back
          // briefly in case it resolves fast" delay only bought a blank
          // pane here (finding #3) — show the loader outright
          // instead of leaving a gap before it mounts.
          <WorkbenchLoadingState delayMs={0} title="Setting up your workbench…" />
        ) : (
          <>
            <h3>What do you want your Workbench to do?</h3>
            <p className="new-workbench-picker-sub">
              Tell it what you're trying to get done. Takes about ten seconds.
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
                <div className="new-workbench-prompt-examples" aria-label="Try an example">
                  <span>Try</span>
                  {[
                    "Review every PR on faremeter/interchange",
                    "Vet Northwind Traders before we sign",
                    "Summarize what shipped each Friday",
                  ].map((example) => (
                    <button
                      key={example}
                      type="button"
                      aria-pressed={prompt === example}
                      className={prompt === example ? "is-selected" : undefined}
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
                    <span className="new-workbench-agent-status">Loading agents…</span>
                  ) : invitableAgents.isError ? (
                    <span className="new-workbench-agent-status" role="status">
                      Couldn&apos;t load agents. You can still start without one.
                    </span>
                  ) : (
                    <div ref={agentPickerRootRef} className="new-workbench-agent-picker">
                      <button
                        ref={agentPickerTriggerRef}
                        type="button"
                        className="new-workbench-add-agent"
                        aria-controls={AGENT_LISTBOX_ID}
                        aria-expanded={agentPickerOpen}
                        onClick={() => (agentPickerOpen ? closeAgentPicker() : openAgentPicker())}
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
                                  Math.min(current + 1, filteredAgents.length - 1),
                                );
                              }
                              if (event.key === "ArrowUp") {
                                event.preventDefault();
                                setActiveAgentIndex((current) => Math.max(current - 1, 0));
                              }
                              if (event.key === "Enter") {
                                // Implicit form submission would otherwise
                                // fire on a miss, creating a workbench the
                                // operator did not ask for.
                                event.preventDefault();
                                const activeAgent = filteredAgents[activeAgentIndex];
                                if (activeAgent !== undefined) {
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
                              {invitableAgents.data?.length === 0
                                ? "No agents are available yet."
                                : "No agents match that search."}
                            </p>
                          ) : (
                            <div id={AGENT_LISTBOX_ID} role="listbox" aria-label="Available agents">
                              {filteredAgents.map((agent, index) => {
                                const selected = selectedAgentDefinitionIds.includes(agent.id);
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
                                    onMouseMove={() => setActiveAgentIndex(index)}
                                    onClick={() => toggleAgent(agent.id)}
                                  >
                                    <span className="new-workbench-agent-option-name">
                                      {agentDisplayName(agent)}
                                    </span>
                                    <span className="new-workbench-agent-option-handle">
                                      {agent.name}
                                    </span>
                                    {selected ? <span aria-hidden="true">✓</span> : null}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            className="mt-2 w-full justify-start border-t border-border"
                            onClick={() => {
                              closeAgentPicker();
                              setCreateAgentOpen(true);
                            }}
                          >
                            + Create agent
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )}
                </div>
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

            <button
              type="button"
              className="new-workbench-empty-channel"
              disabled={creating || selectedTenantId === null}
              onClick={() => void handleCreate()}
            >
              Or <span>just open an empty channel</span> — nobody is in it yet, add people and
              agents as you go.
            </button>
          </>
        )}
      </div>
      {selectedTenantId !== null && createAgentOpen ? (
        <CreateAgentPanel
          key={selectedTenantId}
          open={createAgentOpen}
          onOpenChange={setCreateAgentOpen}
          tenantId={selectedTenantId}
          onCreated={(deployment) => {
            if (currentTenantIdRef.current !== selectedTenantId) return;
            void getAgentRun(selectedTenantId, deployment.id).then((run) => {
              if (currentTenantIdRef.current !== selectedTenantId) return;
              queryClient.setQueryData<Awaited<ReturnType<typeof listTenantInvitableDefinitions>>>(
                ["tenant", selectedTenantId, "invitable-definitions"],
                (current) => [
                  ...(current ?? []).filter((agent) => agent.id !== run.definitionId),
                  { id: run.definitionId, name: run.definitionName },
                ],
              );
              setSelectedAgentDefinitionIds((current) => [...current, run.definitionId]);
            });
            promptRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
