// The "New task" affordance: pick an agent (via an injected
// `AgentSelectionStrategy` — see ./agent-selection-strategy.tsx),
// write a prompt, optionally pick a model (only when the tenant's
// dynamic model catalog offers more than the empty set — mirrors
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
} from "@corbits/react-ui";
import { useCallback, useEffect, useState } from "react";

import type { AgentSelectionStrategy } from "./agent-selection-strategy";
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
  agentSelectionStrategy: AgentSelection,
  listModels,
  initialDefinitionId = null,
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
  /** Renders the "Agent" field — see ./agent-selection-strategy.tsx.
   * Required, never defaulted: a caller wires its own strategy (the
   * manual picker today) explicitly. */
  readonly agentSelectionStrategy: AgentSelectionStrategy;
  readonly listModels: (tenantId: string) => Promise<readonly CatalogModel[]>;
  /** The most-recently-used agent, if the caller tracks one (e.g. the
   * global Cmd+T shortcut preselects it) — pre-selects the field the
   * strategy renders, without changing how the strategy itself picks
   * an agent. Absent means no default, the same as before this prop
   * existed. */
  readonly initialDefinitionId?: string | null;
}) {
  const [definitionId, setDefinitionId] = useState<string | null>(
    initialDefinitionId,
  );
  const [prompt, setPrompt] = useState("");
  const [modelPreference, setModelPreference] = useState<string>("");
  const [modelState, setModelState] = useState<ListState<CatalogModel>>({
    kind: "loading",
  });

  // Reseeded on every open (not on every render) so a person's own
  // reselect inside one open dialog is never clobbered — this only
  // ever runs on the false->true edge.
  useEffect(() => {
    if (open) setDefinitionId(initialDefinitionId);
  }, [open, initialDefinitionId]);

  // The preseeded default is a *memory*, not a fact — the remembered
  // agent may have been deleted since. Once the strategy reports what
  // it can actually offer, a selection outside that set is cleared so
  // a stale default can never ride a submit. A person's own click is
  // always inside the set, so this only ever clears the seed.
  const handleOptionsResolved = useCallback((ids: readonly string[]) => {
    setDefinitionId((current) =>
      current !== null && !ids.includes(current) ? null : current,
    );
  }, []);

  function reset() {
    setDefinitionId(initialDefinitionId);
    setPrompt("");
    setModelPreference("");
  }

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

  // The one submit gate, shared by the button, the form submit, and
  // the Cmd/Ctrl+Enter path — `submitting` included, so a keyboard
  // submit can never re-fire `onCreate` while a launch is in flight
  // the way only the button's `disabled` attribute used to prevent.
  function handleSubmit() {
    if (!canSubmit || submitting) return;
    if (definitionId === null) return;
    const base = { definitionId, prompt: prompt.trim() };
    onCreate(
      modelPreference.trim().length > 0
        ? { ...base, modelPreference: modelPreference.trim() }
        : base,
    );
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
              {open ? (
                <AgentSelection
                  tenantId={tenantId}
                  selectedId={definitionId}
                  onSelect={setDefinitionId}
                  onOptionsResolved={handleOptionsResolved}
                />
              ) : null}
            </fieldset>
            <div className="tasks-form-field">
              <label htmlFor="new-task-prompt" className="tasks-field-label">
                Prompt
              </label>
              <textarea
                id="new-task-prompt"
                className="tasks-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  // Cmd/Ctrl+Enter submits — a bare Enter still inserts
                  // a newline, since prompts are often multi-line.
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault();
                    handleSubmit();
                  }
                }}
                placeholder="What should the agent do?"
                rows={4}
                autoFocus
              />
              <p className="tasks-field-hint">⌘/Ctrl+Enter to start</p>
            </div>
            {modelState.kind === "ready" && modelState.items.length > 0 ? (
              <div
                className="tasks-form-field"
                data-testid="new-task-model-select"
              >
                <label htmlFor="new-task-model" className="tasks-field-label">
                  Model
                </label>
                <select
                  id="new-task-model"
                  className="tasks-select"
                  value={modelPreference}
                  onChange={(event) => setModelPreference(event.target.value)}
                >
                  <option value="">Workbench default</option>
                  {modelState.items.map((model) => (
                    <option key={model.id} value={model.canonicalName}>
                      {model.displayName ?? model.canonicalName}
                    </option>
                  ))}
                </select>
              </div>
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
