// The routine editor/detail pane (CL-6125): creating and editing a routine
// happens in the canvas column now, not a stepper `Dialog` — the same
// canvas-column pattern `canvas-column.tsx`'s `ProfileCanvasPane` and
// `ArtifactCanvasPane` already establish (see `canvas-availability.tsx`'s
// `RoutinePanelSubject`). This pane is entirely self-fetching, exactly like
// `ProfileCanvasPane` resolves its own shared channels from a subject's
// address: it's handed only `{ routineId }` and loads the rest itself.
//
// There is no Save button — every field autosaves. A brand-new routine
// (`routineId: null`) stays a local draft until its Name field is committed
// (blurred, non-empty), which fires the one `createRoutine` call every
// panel session makes; every field committed after that is a plain
// `updateRoutine` patch. This mirrors why Active/Delete/Test run are
// disabled until the routine exists — there is nothing yet to toggle,
// delete, or run.
//
// The routine this panel creates always runs against the tenant's
// "assistant" (Myra) workflow definition — the panel collects only a name,
// a free-text instruction, and a trigger, never a workflow pick, so a
// fixed, general-purpose backing definition is the only honest choice
// (see `routines-api.ts`'s `getAssistantDefinitionId` for why "assistant"
// specifically). The instruction is stored as the routine's own
// `input.instruction`, delivered as the launched run's first-turn mail by
// `@corbits/routines`' `renderRoutineInput` — the same seam the old
// stepper's Configure-step trigger fields fed into `input`.
import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Button,
  ConfirmButton,
  EmptyState,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  RunNowButton,
  Switch,
  toast,
} from "@corbits/react-ui";
import { ChevronLeft, Clock, X } from "lucide-react";

import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { cadenceLabel } from "../routine-trigger";
import {
  createRoutine,
  deleteRoutine,
  getAssistantDefinitionId,
  getRoutine,
  listRoutineRuns,
  routineCreatedToast,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
} from "../routines-api";
import type { Routine, RoutineRun, RoutineTrigger } from "../routines-api";
import { RunsTable, TriggerPicker } from "../pages/routines-page";
import {
  createWebhookTrigger,
  DEFAULT_WEBHOOK_INPUT_TEMPLATE,
} from "../webhook-triggers-api";
import { useDeploymentCapabilities } from "../deployment-capabilities-api";
import { tenantKeys } from "../query-client";
import { useCanvasColumnRoutine, useCloseCanvas } from "./canvas-availability";

function instructionFromInput(input: Record<string, unknown>): string {
  const value = input["instruction"];
  return typeof value === "string" ? value : "";
}

/** A trigger's row summary — `sourceLabel` (this panel session's own memory
 * of which "+ Add trigger" option minted a webhook trigger) wins over the
 * generic cadence label for a webhook, since a freshly-reloaded panel has
 * no way to recover which source it was bound to. */
function triggerRowSummary(
  trigger: Exclude<RoutineTrigger, null>,
  sourceLabel: string | null,
): string {
  if (trigger.kind === "webhook") return sourceLabel ?? "On webhook";
  return cadenceLabel(trigger);
}

/**
 * `+ Add trigger` popover contents: schedule is always offered; Granola
 * call notes is a plain inbound webhook binding (no external credential —
 * Granola pushes to us), so it's always offered too; Slack is offered only
 * when this deployment's Slack tag ingress is actually mounted (see
 * `deployment-capabilities-api.ts`) — an unconfigured deployment must never
 * offer a trigger that can't honestly fire.
 */
function AddTriggerMenu({
  slackAvailable,
  onSchedule,
  onGranola,
  onSlack,
  disabled,
}: {
  readonly slackAvailable: boolean;
  readonly onSchedule: () => void;
  readonly onGranola: () => void;
  readonly onSlack: () => void;
  readonly disabled: boolean;
}) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          + Add trigger
        </Button>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onSchedule}>On a schedule ›</MenuItem>
        <MenuItem onSelect={onGranola}>Granola call notes</MenuItem>
        {slackAvailable ? (
          <MenuItem onSelect={onSlack}>Slack</MenuItem>
        ) : null}
      </MenuContent>
    </Menu>
  );
}

export function RoutinePanel() {
  const subject = useCanvasColumnRoutine();
  const close = useCloseCanvas();
  const navigate = useNavigate();
  const { selectedTenantId: tenantId } = useBench();
  const { slackConfigured } = useDeploymentCapabilities();
  const queryClient = useQueryClient();

  const invalidateRoutines = () => {
    if (tenantId === null) return;
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routines(tenantId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routineRunHistories(tenantId),
    });
  };

  const [routineId, setRoutineId] = useState<string | null>(
    subject?.routineId ?? null,
  );
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [savedInstruction, setSavedInstruction] = useState("");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [triggerSourceLabel, setTriggerSourceLabel] = useState<string | null>(
    null,
  );
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RoutineRun[]>([]);

  // A new subject (a different routine, or a fresh "New routine") replaces
  // this pane's entire local draft — nothing from the last session leaks
  // into the next.
  useEffect(() => {
    setRoutineId(subject?.routineId ?? null);
    setName(subject?.routineId == null ? (subject?.initialName ?? "") : "");
    setSavedName("");
    setInstruction(
      subject?.routineId == null ? (subject?.initialInstruction ?? "") : "",
    );
    setSavedInstruction("");
    setTrigger(null);
    setTriggerSourceLabel(null);
    setSchedulePickerOpen(false);
    setEnabled(false);
    setError(null);
    setRuns([]);
    // Every `openRoutine(...)` call constructs a fresh subject object, even
    // back-to-back "New routine" opens with the same (null) routineId but a
    // different prefill — identity, not just `routineId`, is what has to
    // reset this draft.
  }, [subject]);

  const loadRuns = (id: string) => {
    if (tenantId === null) return;
    void listRoutineRuns(tenantId, id).then(
      (loaded) => setRuns(loaded),
      () => setRuns([]),
    );
  };

  const applyRoutine = (routine: Routine) => {
    setRoutineId(routine.id);
    setName(routine.name);
    setSavedName(routine.name);
    const loadedInstruction = instructionFromInput(routine.input);
    setInstruction(loadedInstruction);
    setSavedInstruction(loadedInstruction);
    setTrigger(routine.trigger);
    setEnabled(routine.enabled);
  };

  // Loads an existing routine's real fields once the tenant resolves —
  // mirrors `ProfileCanvasPane`'s own "fetch once open" effect.
  useEffect(() => {
    if (tenantId === null || subject?.routineId == null) return;
    let cancelled = false;
    void getRoutine(tenantId, subject.routineId).then(
      (routine) => {
        if (cancelled) return;
        applyRoutine(routine);
        loadRuns(routine.id);
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, subject?.routineId]);

  /** The one `createRoutine` call this panel session ever makes — fired the
   * first time a field commits with a non-blank name. Every commit after
   * this is a plain `updateRoutine` patch instead. */
  const create = (fields: {
    readonly name: string;
    readonly instruction: string;
    readonly trigger: RoutineTrigger;
  }): Promise<Routine> => {
    if (tenantId === null) {
      return Promise.reject(new Error("No workbench to create this in yet"));
    }
    setBusy(true);
    setError(null);
    return getAssistantDefinitionId(tenantId)
      .then((definitionId) => {
        if (definitionId === null) {
          throw new Error(
            "This workbench has no assistant to run this routine yet.",
          );
        }
        return createRoutine(tenantId, {
          name: fields.name,
          definitionId,
          scope: "personal",
          trigger: fields.trigger,
          runOnceNow: false,
          ...(fields.instruction.trim() !== ""
            ? { input: { instruction: fields.instruction.trim() } }
            : {}),
        });
      })
      .then((routine) => {
        applyRoutine(routine);
        invalidateRoutines();
        toast(routineCreatedToast(routine.name));
        return routine;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      })
      .finally(() => setBusy(false));
  };

  const update = (
    patch: {
      readonly name?: string;
      readonly input?: Record<string, unknown>;
      readonly trigger?: RoutineTrigger;
      readonly enabled?: boolean;
    },
    // Overrides the `routineId` state read for a caller that just created
    // the routine in this same tick — `setRoutineId` inside `create()`
    // hasn't re-rendered yet, so the closure's `routineId` is still stale
    // null at the moment `addWebhookTrigger` needs to bind the fresh id.
    targetRoutineId: string | null = routineId,
  ): Promise<Routine> => {
    if (tenantId === null || targetRoutineId === null) {
      return Promise.reject(new Error("No routine to update yet"));
    }
    setBusy(true);
    setError(null);
    return updateRoutine(tenantId, targetRoutineId, patch)
      .then((routine) => {
        applyRoutine(routine);
        invalidateRoutines();
        return routine;
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        throw cause;
      })
      .finally(() => setBusy(false));
  };

  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (routineId === null) {
      void create({ name: trimmed, instruction, trigger });
      return;
    }
    if (trimmed === savedName) return;
    void update({ name: trimmed });
  };

  const commitInstruction = () => {
    const trimmed = instruction.trim();
    if (routineId === null) {
      if (name.trim() === "") return;
      void create({ name: name.trim(), instruction, trigger });
      return;
    }
    if (trimmed === savedInstruction) return;
    void update({ input: { instruction: trimmed } });
  };

  const commitTrigger = (
    nextTrigger: RoutineTrigger,
    sourceLabel: string | null,
    targetRoutineId: string | null = routineId,
  ) => {
    setTrigger(nextTrigger);
    setTriggerSourceLabel(sourceLabel);
    if (targetRoutineId === null) return;
    void update({ trigger: nextTrigger }, targetRoutineId);
  };

  const addWebhookTrigger = (sourceLabel: string) => {
    if (tenantId === null) return;
    const proceed = (id: string, definitionId: string) => {
      setBusy(true);
      setError(null);
      void createWebhookTrigger(tenantId, {
        name: `${name.trim() || "Untitled routine"} — ${sourceLabel}`,
        workflowDefinitionId: definitionId,
        inputTemplate: DEFAULT_WEBHOOK_INPUT_TEMPLATE,
      })
        .then((binding) =>
          commitTrigger(
            { kind: "webhook", webhookTriggerId: binding.id },
            sourceLabel,
            id,
          ),
        )
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setBusy(false));
    };
    if (routineId !== null) {
      void getAssistantDefinitionId(tenantId).then((definitionId) => {
        if (definitionId !== null) proceed(routineId, definitionId);
      });
      return;
    }
    const trimmedName = name.trim() || "Untitled routine";
    void create({ name: trimmedName, instruction, trigger: null }).then(
      (routine) => proceed(routine.id, routine.definitionId),
    );
  };

  const toggleActive = (next: boolean) => {
    setEnabled(next);
    void update({ enabled: next }).catch(() => {
      setEnabled(!next);
    });
  };

  const removeTrigger = () => commitTrigger(null, null);

  return (
    <div className="shell-routine-pane flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={close}
            aria-label="Back"
            title="Back"
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm font-medium">Routine</span>
        </div>
      </div>
      <div className="flex items-center gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <Switch
          checked={enabled}
          disabled={routineId === null || busy}
          label={`${enabled ? "Pause" : "Resume"} ${name || "this routine"}`}
          onCheckedChange={toggleActive}
        />
        {routineId !== null ? (
          <ConfirmButton
            variant="outline"
            size="sm"
            confirmLabel="Delete this routine — click again to confirm"
            onConfirm={() => {
              if (tenantId === null || routineId === null) return;
              void deleteRoutine(tenantId, routineId).then(() => {
                invalidateRoutines();
                close();
              });
            }}
          >
            Delete
          </ConfirmButton>
        ) : null}
        <RunNowButton
          variant="outline"
          size="sm"
          disabled={routineId === null}
          onRun={() => {
            if (tenantId === null || routineId === null) return;
            return runRoutineNow(tenantId, routineId).then(() => {
              toast(routineRunStartedToast(name));
              loadRuns(routineId);
              invalidateRoutines();
            });
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="routine-panel-name" className="text-xs font-medium">
            Name this routine
          </label>
          <Input
            id="routine-panel-name"
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onBlur={commitName}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="routine-panel-instruction"
            className="text-xs font-medium"
          >
            What should this routine do each time it runs?
          </label>
          <textarea
            id="routine-panel-instruction"
            className="min-h-20 w-full rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg)] px-2.5 py-1.5 text-sm text-[var(--ui-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-accent)]"
            value={instruction}
            disabled={busy}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
              setInstruction(event.target.value)
            }
            onBlur={commitInstruction}
          />
        </div>

        {error !== null ? (
          <p className="text-xs text-[var(--ui-danger)]" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium">When to run</span>
          {trigger === null && !schedulePickerOpen ? (
            <AddTriggerMenu
              slackAvailable={slackConfigured}
              disabled={busy}
              onSchedule={() => setSchedulePickerOpen(true)}
              onGranola={() => addWebhookTrigger("Granola call notes")}
              onSlack={() => addWebhookTrigger("Slack")}
            />
          ) : schedulePickerOpen ? (
            <TriggerPicker
              value={trigger}
              onChange={(next) => {
                commitTrigger(next, null);
                if (next !== null) setSchedulePickerOpen(false);
              }}
            />
          ) : trigger !== null ? (
            <div className="flex items-center justify-between gap-2 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] px-2.5 py-1.5 text-sm">
              <span>{triggerRowSummary(trigger, triggerSourceLabel)}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Remove trigger"
                onClick={removeTrigger}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ) : null}
        </div>

        <section aria-label="Run history">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
              Run history
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate("/insights/runs")}
            >
              Insights →
            </Button>
          </div>
          {routineId === null ? (
            <EmptyState
              icon={<Clock />}
              title="No runs yet"
              description="Save this routine to see it here."
            />
          ) : (
            <RunsTable
              runs={runs.slice(0, 10)}
              now={Date.now()}
              emptyTitle="No runs yet"
              emptyDescription="This routine has not fired yet — manually or on a schedule."
            />
          )}
        </section>
      </div>
    </div>
  );
}
