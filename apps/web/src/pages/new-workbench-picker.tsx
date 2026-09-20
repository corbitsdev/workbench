// A new workbench is a child tenant plus the agents you put in it. This
// screen is the prompt box: say what you want and hit Enter, or open an
// empty workbench and add people and agents as you go.

import { Button, toast } from "@corbits/react-ui";
import { useDismissablePopover } from "@corbits/react-ui/hooks/use-dismissable-popover";
import { PaperPlaneRight } from "@/lib/icons";
import { CHAT_STRINGS, WorkbenchLoadingState } from "@/chat";
import { isMyraAgent, listChatAgents } from "@/chat/threads-api";
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { reportError } from "@corbits/error-sink";

import { useBench } from "../bench-context";
import { workbenchKeys } from "../chat-path";
import { createWorkbench, WorkbenchCreateError } from "../workbench-create";
import { useNavigate } from "../navigation";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchPath } from "../workbench-path";
import { CreateAgentPanel } from "./create-agent-panel";

const GENERIC_CREATE_FAILURE = "Something went wrong creating this workbench. Try again.";

/** Allow-lists what is safe to show verbatim: only the authored
 * stage copy, never a raw request path or schema summary. */
export function describeWorkbenchCreateFailure(cause: unknown, refId?: string): string {
  if (!(cause instanceof WorkbenchCreateError)) return GENERIC_CREATE_FAILURE;
  const message =
    cause.stage === "opening-message"
      ? "Workbench created, but we couldn't send the opening message. Try again from the workbench."
      : cause.stage === "deploy"
        ? "Workbench created, but its agent couldn't be deployed into it. Try again from the workbench."
        : GENERIC_CREATE_FAILURE;
  return refId === undefined ? message : `${message} Reference: ${refId}`;
}

const PROMPT_PLACEHOLDER = "What do you want your Workbench to do?";
const AGENT_LISTBOX_ID = "new-workbench-agent-listbox";

/** A workbench's name is its opening ask, trimmed — an empty workbench is just
 * "Workbench" until it is renamed. */
function workbenchName(prompt: string): string {
  const trimmed = prompt.trim();
  return trimmed === "" ? "Workbench" : trimmed.slice(0, 60);
}

export function NewWorkbenchPickerRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedTenantId } = useBench();
  const [prompt, setPrompt] = useState("");
  const [selectedAgentIds, setSelectedAgentIds] = useState<readonly string[]>([]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState("");
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
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

  const agentsQuery = useQuery({
    queryKey: ["bench-agents", selectedTenantId],
    queryFn: () => listChatAgents(selectedTenantId!),
    enabled: selectedTenantId !== null,
  });
  const pickableAgents = useMemo(
    () => (agentsQuery.data ?? []).filter((agent) => !isMyraAgent(agent)),
    [agentsQuery.data],
  );
  const filteredAgents = useMemo(() => {
    const query = agentQuery.trim().toLocaleLowerCase();
    return query === ""
      ? pickableAgents
      : pickableAgents.filter((agent) => agent.name.toLocaleLowerCase().includes(query));
  }, [pickableAgents, agentQuery]);
  const selectedAgents = pickableAgents.filter((agent) => selectedAgentIds.includes(agent.id));

  function toggleAgent(id: string) {
    setSelectedAgentIds((current) =>
      current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
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

  const create = useMutation({
    mutationFn: ({
      benchTenantId,
      openingMessage,
    }: {
      readonly benchTenantId: string;
      readonly openingMessage: string | undefined;
    }) =>
      createWorkbench({
        benchTenantId,
        name: workbenchName(openingMessage ?? ""),
        ...(openingMessage !== undefined ? { openingMessage } : {}),
        pickedAgents: pickableAgents
          .filter((agent) => selectedAgentIds.includes(agent.id))
          .map((agent) => ({ id: agent.id, name: agent.name, assetName: agent.assetName })),
      }),
    onSuccess: (tenantId, variables) => {
      void queryClient.invalidateQueries({
        queryKey: workbenchKeys.childTenants(variables.benchTenantId),
      });
      navigate(workbenchPath(tenantId));
    },
    onError: (cause: unknown, variables) => {
      const refId = reportError(cause, {
        operation: "workbench_create",
        ...(selectedTenantId !== null ? { tenantId: selectedTenantId } : {}),
      });
      toast(describeWorkbenchCreateFailure(cause, refId));
      // The workbench exists once a later stage fails; the toast says to retry
      // from the workbench, so go there.
      if (cause instanceof WorkbenchCreateError && cause.tenantId !== undefined) {
        void queryClient.invalidateQueries({
          queryKey: workbenchKeys.childTenants(variables.benchTenantId),
        });
        navigate(workbenchPath(cause.tenantId));
      }
    },
  });

  function startCreate(openingMessage?: string) {
    if (selectedTenantId === null || create.isPending) return;
    create.mutate({
      benchTenantId: selectedTenantId,
      ...(openingMessage !== undefined ? { openingMessage } : { openingMessage: undefined }),
    });
  }

  function handlePromptSubmit() {
    const trimmed = prompt.trim();
    if (trimmed === "") return;
    startCreate(trimmed);
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
        {create.isPending ? (
          // `delayMs={0}`: this is a genuine wait the instant the person
          // hits Enter, so the default hold-back only bought a blank pane.
          <WorkbenchLoadingState delayMs={0} title="Setting up your workbench…" />
        ) : (
          <>
            <h3>What do you want your Workbench to do?</h3>
            <p className="new-workbench-picker-sub">
              Tell it what you&apos;re trying to get done. Takes about ten seconds.
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
                  <span>In the workbench</span>
                  {selectedAgents.map((agent) => (
                    <span key={agent.id} className="new-workbench-agent-chip">
                      {agent.name}
                      <button
                        type="button"
                        aria-label={`Remove ${agent.name}`}
                        onClick={() => toggleAgent(agent.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {agentsQuery.isLoading ? (
                    <span className="new-workbench-agent-status">Loading agents…</span>
                  ) : agentsQuery.isError ? (
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
                              {pickableAgents.length === 0
                                ? "No agents are available yet."
                                : "No agents match that search."}
                            </p>
                          ) : (
                            <div id={AGENT_LISTBOX_ID} role="listbox" aria-label="Available agents">
                              {filteredAgents.map((agent, index) => {
                                const selected = selectedAgentIds.includes(agent.id);
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
              disabled={create.isPending || selectedTenantId === null}
              onClick={() => startCreate()}
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
            void queryClient.invalidateQueries({
              queryKey: ["bench-agents", selectedTenantId],
            });
            setSelectedAgentIds((current) => [...current, deployment.definitionAssetId]);
            promptRef.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
