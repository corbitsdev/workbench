// The routine panel (CL-6125, reworked CL-6139, trimmed to editor-only by
// CL-6362): a create/edit pane in the canvas column, beside the
// conversation — never a route hop. Browsing and running existing
// routines lives on the global `/routines` page now (the shell rail's
// Routines row) — this pane only ever opens straight to
// `RoutineEditorPanel`, for a specific routine (`routineId`) or a
// brand-new one. Back closes the canvas — there is no list view to step
// back to anymore.
//
// There is no Save button — every field autosaves on blur/select, and
// every write (create or update) is serialized through one queue
// (`runWrite` in `RoutineEditorPanel`) so two near-simultaneous commits —
// Name's blur and Instruction's blur landing in the same tick, say — can
// never both decide "no routine yet, create one" and fire two POSTs. The
// second write's create-vs-update decision is made only once the first
// has actually finished, not from a state snapshot taken before either
// ran. `saveState` ("saving…" / "saved" / an honest inline error) reflects
// that same queue, not any individual field's own fetch.
//
// A routine created from this panel always targets the conversation it
// was opened beside: every workbench's host participant is Myra, so "this
// workbench's own agent" resolves to that workbench's host agent
// (`listWorkbenchAgents`), and the routine delivers back into that same
// workbench — never a new one. A panel opened with no workbench in scope (a
// deliberate `/routines` visit) cannot invent a delivery conversation: Myra
// is an agent row, not a home-slot find-or-create. The create needs a
// conversation already in scope.
import { useEffect, useRef, useState } from "react";
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
  Textarea,
  toast,
} from "@corbits/react-ui";
import { listWorkbenchAgents } from "@corbits/chat-ui";
import { Clock, X } from "@corbits/icons";

import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { routineScheduleSentence } from "@corbits/routines/client";
import { ScheduleEditor } from "../routine-schedule";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listRoutineRuns,
  routineCreatedToast,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
} from "../routines-api";
import type { Routine, RoutineRun, RoutineTrigger } from "../routines-api";
import { RunsTable } from "../pages/routines-page";
import {
  createWebhookTrigger,
  DEFAULT_WEBHOOK_INPUT_TEMPLATE,
} from "../webhook-triggers-api";
import { useDeploymentCapabilities } from "../deployment-capabilities-api";
import { tenantKeys } from "../query-client";
import { useCanvasColumnRoutine, useCloseCanvas } from "./canvas-availability";
import type { RoutinePanelSubject } from "./canvas-availability";
import { CanvasPaneHeader } from "./canvas-column";

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
  return routineScheduleSentence(trigger);
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
        {slackAvailable ? <MenuItem onSelect={onSlack}>Slack</MenuItem> : null}
      </MenuContent>
    </Menu>
  );
}

/** Opens straight to the routine editor — create (no `routineId`) or edit
 * an existing one. Routines' list/browse surface (name, cadence, enabled,
 * recent runs) is the global `/routines` page now (CL-6362); this pane is
 * only ever reached from a creation entry point (the composer's
 * `/routine` command, "New routine in this space", "Make this a
 * routine") or an "Edit" action already carrying a `routineId`. */
export function RoutinePanel() {
  const subject = useCanvasColumnRoutine();
  const close = useCloseCanvas();

  if (subject === null) return null;

  return (
    <RoutineEditorPanel subject={subject} onBack={close} onClose={close} />
  );
}

type SaveState = "idle" | "saving" | "saved" | "error";

type CreateTarget = {
  readonly definitionId: string;
  readonly deliveryWorkbenchId: string;
};

/** The editor view: create/edit one routine. Self-fetching — handed only
 * the subject, loads the rest itself, exactly like `ProfileCanvasPane`. */
function RoutineEditorPanel({
  subject,
  onBack,
  onClose,
}: {
  readonly subject: RoutinePanelSubject;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
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
    subject.routineId ?? null,
  );
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [savedInstruction, setSavedInstruction] = useState("");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [triggerSourceLabel, setTriggerSourceLabel] = useState<string | null>(
    null,
  );
  const [addingSchedule, setAddingSchedule] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RoutineRun[]>([]);

  // Every write (create or update) this panel session makes runs through
  // this one chain — never two in flight at once. `routineIdRef` is the
  // decision the chained tasks read: it only updates once a write actually
  // resolves, so a second commit queued before the first finished sees the
  // *post*-first-write id, not a stale snapshot from before either ran.
  const routineIdRef = useRef<string | null>(routineId);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());

  // A new subject (a different routine, or a fresh "New routine") replaces
  // this pane's entire local draft — nothing from the last session leaks
  // into the next, including any write still chained from it.
  useEffect(() => {
    routineIdRef.current = subject.routineId ?? null;
    writeChainRef.current = Promise.resolve();
    setRoutineId(subject.routineId ?? null);
    setName(subject.routineId == null ? (subject.initialName ?? "") : "");
    setSavedName("");
    setInstruction(
      subject.routineId == null ? (subject.initialInstruction ?? "") : "",
    );
    setSavedInstruction("");
    setTrigger(null);
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    setEnabled(false);
    setSaveState("idle");
    setError(null);
    setRuns([]);
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
    routineIdRef.current = routine.id;
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
    if (tenantId === null || subject.routineId == null) return;
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
  }, [tenantId, subject.routineId]);

  /** This routine's own agent + delivery workbench: the conversation the
   * panel was opened beside (its host participant — every workbench's
   * host is Myra). A panel with no conversation in scope cannot invent
   * one — Myra is not a home-slot find-or-create. */
  const resolveCreateTarget = async (): Promise<CreateTarget> => {
    if (tenantId === null) {
      throw new Error("No workbench to create this in yet");
    }
    if (subject.workbenchId === undefined) {
      throw new Error("Open a conversation to create this routine.");
    }
    const workbenchId = subject.workbenchId;
    const agents = await listWorkbenchAgents(tenantId, workbenchId);
    const definitionId = agents[0]?.definitionId;
    if (definitionId === undefined) {
      throw new Error(
        "This conversation has no agent to run this routine yet.",
      );
    }
    return { definitionId, deliveryWorkbenchId: workbenchId };
  };

  /** Every create/update this panel makes funnels through this one chain —
   * `task` reads the *current* routine id only when it actually runs, so
   * two commits queued in the same tick still execute, and decide
   * create-vs-update, strictly one after the other. */
  const runWrite = (
    task: (currentId: string | null) => Promise<Routine>,
  ): Promise<void> => {
    const next = writeChainRef.current.then(async () => {
      setSaveState("saving");
      setError(null);
      try {
        const routine = await task(routineIdRef.current);
        applyRoutine(routine);
        invalidateRoutines();
        setSaveState("saved");
      } catch (cause) {
        setSaveState("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    writeChainRef.current = next;
    return next;
  };

  const doCreate = async (fields: {
    readonly name: string;
    readonly instruction: string;
    readonly trigger: RoutineTrigger;
  }): Promise<Routine> => {
    const target = await resolveCreateTarget();
    const routine = await createRoutine(tenantId as string, {
      name: fields.name,
      definitionId: target.definitionId,
      deliveryWorkbenchId: target.deliveryWorkbenchId,
      scope: "personal",
      trigger: fields.trigger,
      runOnceNow: false,
      ...(fields.instruction.trim() !== ""
        ? { input: { instruction: fields.instruction.trim() } }
        : {}),
    });
    toast(routineCreatedToast(routine.name));
    return routine;
  };

  // The create-vs-update decision is made *inside* each queued task, from
  // the `id` `runWrite` hands it at the moment it actually runs — never
  // from `routineIdRef.current` read here, before either write's turn in
  // the chain. Name's blur and Instruction's blur can both fire in the
  // same tick, both see "no routine yet" at read time here, and both
  // still enqueue — but only the first task to actually execute creates;
  // by the time the second runs, the chain has already applied the first
  // write's result, so it correctly updates instead. The bail-outs below
  // (blank name, unchanged value) are safe to read eagerly — being a tick
  // stale there costs at most one redundant PATCH, never a second POST.
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (routineIdRef.current !== null && trimmed === savedName) return;
    void runWrite((id) => {
      if (id === null) return doCreate({ name: trimmed, instruction, trigger });
      return updateRoutine(tenantId as string, id, { name: trimmed });
    });
  };

  const commitInstruction = () => {
    const trimmed = instruction.trim();
    if (routineIdRef.current === null && name.trim() === "") return;
    if (routineIdRef.current !== null && trimmed === savedInstruction) return;
    void runWrite((id) => {
      if (id === null) {
        return doCreate({ name: name.trim(), instruction, trigger });
      }
      return updateRoutine(tenantId as string, id, {
        input: { instruction: trimmed },
      });
    });
  };

  const commitSchedule = (next: Exclude<RoutineTrigger, null>) => {
    setTrigger(next);
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    void runWrite((id) => {
      if (id === null) {
        return doCreate({
          name: name.trim() || "Untitled routine",
          instruction,
          trigger: next,
        });
      }
      return updateRoutine(tenantId as string, id, { trigger: next });
    });
  };

  const removeTrigger = () => {
    setTrigger(null);
    setTriggerSourceLabel(null);
    void runWrite((id) => {
      if (id === null) {
        return Promise.reject(new Error("No routine to update yet"));
      }
      return updateRoutine(tenantId as string, id, { trigger: null });
    });
  };

  const addWebhookTrigger = (sourceLabel: string) => {
    void runWrite(async (id) => {
      if (tenantId === null) {
        throw new Error("No workbench to create this in yet");
      }
      let targetRoutineId = id;
      let definitionId: string;
      if (targetRoutineId === null) {
        const target = await resolveCreateTarget();
        const created = await createRoutine(tenantId, {
          name: name.trim() || "Untitled routine",
          definitionId: target.definitionId,
          deliveryWorkbenchId: target.deliveryWorkbenchId,
          scope: "personal",
          trigger: null,
          runOnceNow: false,
          ...(instruction.trim() !== ""
            ? { input: { instruction: instruction.trim() } }
            : {}),
        });
        targetRoutineId = created.id;
        definitionId = created.definitionId;
        toast(routineCreatedToast(created.name));
      } else {
        definitionId = (await resolveCreateTarget()).definitionId;
      }
      const binding = await createWebhookTrigger(tenantId, {
        name: `${name.trim() || "Untitled routine"} — ${sourceLabel}`,
        workflowDefinitionId: definitionId,
        inputTemplate: DEFAULT_WEBHOOK_INPUT_TEMPLATE,
      });
      setTriggerSourceLabel(sourceLabel);
      return updateRoutine(tenantId, targetRoutineId, {
        trigger: { kind: "webhook", webhookTriggerId: binding.id },
      });
    });
  };

  const toggleActive = (next: boolean) => {
    setEnabled(next);
    void runWrite((id) => {
      if (id === null) {
        setEnabled(!next);
        return Promise.reject(new Error("No routine to update yet"));
      }
      return updateRoutine(tenantId as string, id, { enabled: next }).catch(
        (cause: unknown) => {
          setEnabled(!next);
          throw cause;
        },
      );
    });
  };

  const busy = saveState === "saving";

  return (
    <div className="shell-routine-pane flex h-full min-h-0 flex-col">
      <CanvasPaneHeader
        className="px-3 pt-2"
        title="Routine"
        onBack={onBack}
        trailing={
          saveState === "saving" ? (
            <span className="text-xs text-[var(--ui-fg-muted)]" role="status">
              Saving…
            </span>
          ) : saveState === "saved" ? (
            <span className="text-xs text-[var(--ui-fg-muted)]" role="status">
              Saved
            </span>
          ) : null
        }
      />
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
                onClose();
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
          <Textarea
            id="routine-panel-instruction"
            className="min-h-20"
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
          {trigger === null && !addingSchedule ? (
            <AddTriggerMenu
              slackAvailable={slackConfigured}
              disabled={busy}
              onSchedule={() => setAddingSchedule(true)}
              onGranola={() => addWebhookTrigger("Granola call notes")}
              onSlack={() => addWebhookTrigger("Slack")}
            />
          ) : trigger === null && addingSchedule ? (
            <ScheduleEditor
              value={null}
              onChange={commitSchedule}
              disabled={busy}
            />
          ) : trigger !== null && trigger.kind === "webhook" ? (
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
          ) : trigger !== null ? (
            <div className="flex flex-col gap-2">
              <ScheduleEditor
                value={trigger}
                onChange={commitSchedule}
                disabled={busy}
              />
              <div className="flex justify-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="Remove trigger"
                  onClick={removeTrigger}
                >
                  <X className="size-3.5" /> Remove
                </Button>
              </div>
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
