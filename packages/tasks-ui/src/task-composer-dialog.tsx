// The "New task" affordance: pick an agent definition, write a prompt,
// optionally pick a model (only when the tenant's dynamic model
// catalog offers more than the empty set — mirrors
// `apps/web/src/pages/create-agent-dialog.tsx`'s own "hide when
// there's nothing to pick" rule). Submitting launches the task and
// closes; the result reaches the caller later through the Inbox, not
// through this dialog — a task is spawn-and-return, never a live view
// of the run.
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
  Skeleton,
} from "@corbits/react-ui";
import type { InvitableDefinition } from "@corbits/chat-ui";
import { CircleAlert, Users } from "lucide-react";
import { useEffect, useState } from "react";

import type { CatalogModel } from "./api";

type ListState<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly items: readonly T[] };

export function canSubmitTask(
  definitionId: string | null,
  prompt: string,
): boolean {
  return definitionId !== null && prompt.trim().length > 0;
}

export function TaskComposerDialog({
  open,
  onOpenChange,
  onCreate,
  tenantId,
  submitting,
  error = null,
  listAgents,
  listModels,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreate: (input: {
    readonly definitionId: string;
    readonly prompt: string;
    readonly modelPreference?: string;
  }) => void;
  readonly tenantId: string;
  readonly submitting: boolean;
  readonly error?: string | null;
  readonly listAgents: (
    tenantId: string,
  ) => Promise<readonly InvitableDefinition[]>;
  readonly listModels: (tenantId: string) => Promise<readonly CatalogModel[]>;
}) {
  const [definitionId, setDefinitionId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [modelPreference, setModelPreference] = useState<string>("");
  const [agentState, setAgentState] = useState<ListState<InvitableDefinition>>({
    kind: "loading",
  });
  const [modelState, setModelState] = useState<ListState<CatalogModel>>({
    kind: "loading",
  });

  function reset() {
    setDefinitionId(null);
    setPrompt("");
    setModelPreference("");
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setAgentState({ kind: "loading" });
    listAgents(tenantId)
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
  }, [open, tenantId, listAgents]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModelState({ kind: "loading" });
    listModels(tenantId)
      .then((items) => {
        if (!cancelled) setModelState({ kind: "ready", items });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setModelState({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, tenantId, listModels]);

  const canSubmit = canSubmitTask(definitionId, prompt);

  function handleSubmit() {
    if (definitionId === null) return;
    const trimmedPrompt = prompt.trim();
    if (trimmedPrompt.length === 0) return;
    onCreate({
      definitionId,
      prompt: trimmedPrompt,
      ...(modelPreference.trim().length > 0
        ? { modelPreference: modelPreference.trim() }
        : {}),
    });
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
          <DialogTitle>New task</DialogTitle>
          <DialogDescription>
            Give an agent a prompt. It runs on its own, and the result lands in
            your Inbox when it's done.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form
            id="new-task-form"
            className="tasks-composer-form"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <fieldset
              className="tasks-form-field"
              data-testid="new-task-agent-picker"
            >
              <legend className="tasks-field-label">Agent</legend>
              <AgentPicker
                state={agentState}
                selectedId={definitionId}
                onSelect={setDefinitionId}
              />
            </fieldset>
            <label className="tasks-form-field">
              <span className="tasks-field-label">Prompt</span>
              <textarea
                className="tasks-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="What should the agent do?"
                rows={4}
                autoFocus
              />
            </label>
            {modelState.kind === "ready" && modelState.items.length > 0 ? (
              <label
                className="tasks-form-field"
                data-testid="new-task-model-select"
              >
                <span className="tasks-field-label">Model</span>
                <select
                  className="tasks-select"
                  value={modelPreference}
                  onChange={(event) => setModelPreference(event.target.value)}
                >
                  <option value="">Bench default</option>
                  {modelState.items.map((model) => (
                    <option key={model.id} value={model.canonicalName}>
                      {model.displayName ?? model.canonicalName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {error !== null && (
              <p className="tasks-dialog-error" role="alert">
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
            Cancel
          </Button>
          <Button
            type="submit"
            form="new-task-form"
            variant="primary"
            disabled={!canSubmit || submitting}
          >
            {submitting ? "Starting…" : "Start task"}
          </Button>
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
  readonly state: ListState<InvitableDefinition>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  if (state.kind === "loading") return <Skeleton className="query-skeleton" />;
  if (state.kind === "error") {
    return (
      <EmptyState
        icon={<CircleAlert />}
        title="Couldn't load agents"
        description={state.message}
      />
    );
  }
  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={<Users />}
        title="No agents yet"
        description="Create an agent before giving it a task."
      />
    );
  }
  return (
    <>
      {state.items.map((definition) => (
        <label
          key={definition.id}
          className="tasks-radio-option"
          data-testid="new-task-agent-option"
        >
          <input
            type="radio"
            name="task-agent"
            checked={selectedId === definition.id}
            onChange={() => onSelect(definition.id)}
          />
          {definition.description ?? definition.name}
        </label>
      ))}
    </>
  );
}
