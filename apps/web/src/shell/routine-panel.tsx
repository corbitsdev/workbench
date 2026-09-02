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
// that same queue, not any individual field's own fetch. A write ack
// never clobbers dirty draft fields (CL-6755): typing instruction or
// picking a schedule while another field's save is in flight keeps the
// in-progress values.
//
// The routine's delivery destination is the conversation this panel was
// opened beside — its own id is where the routine delivers back into. A
// panel opened with no workbench in scope (a deliberate `/routines` visit)
// falls back to the workbench's own default Myra workbench
// (`ensureMyraWorkbench`, the one deliberate find-or-create path in the
// product). What the routine *runs* is a separate, explicit choice (CL-7355):
// the panel no longer infers it from the conversation's own agent — a
// person picks a target from `DefinitionTargetPicker`, backed by
// `GET /api/tenants/:tenantId/workflows/targets`.
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
import { Clock, X } from "@corbits/icons";

import { useBench } from "../bench-context";
import { useNavigate } from "../navigation";
import { ensureMyraWorkbench } from "../myra-workbench";
import { routineScheduleSentence } from "@corbits/routines/client";
import { ScheduleEditor } from "../routine-schedule";
import { DefinitionTargetPicker } from "./definition-target-picker";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  listAllRoutineTargets,
  listRoutineRuns,
  routineCreatedToast,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
} from "../routines-api";
import type {
  Routine,
  RoutineRun,
  RoutineTarget,
  RoutineTrigger,
} from "../routines-api";
import { RunsTable } from "../pages/routines-page";
import {
  createWebhookTrigger,
  DEFAULT_WEBHOOK_INPUT_TEMPLATE,
} from "../webhook-triggers-api";
import {
  useDeploymentCapabilities,
  slackTriggerOffered,
} from "../deployment-capabilities-api";
import { useGranolaPluginConnected } from "../granola-plugin-availability";
import { invalidateRoutineQueries } from "../query-client";
import { useCanvasColumnRoutine, useCloseCanvas } from "./canvas-availability";
import type { RoutinePanelSubject } from "./canvas-availability";
import { CanvasPaneHeader } from "./canvas-column";

function instructionFromInput(input: Record<string, unknown>): string {
  const value = input["instruction"];
  return typeof value === "string" ? value : "";
}

function triggersEqual(a: RoutineTrigger, b: RoutineTrigger): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Live draft + last-acked server values — `ackRoutine` reads this ref (not a
 * render closure) so a write that resolves after the user kept typing still
 * sees the current dirty state (CL-6755). */
type DraftSnapshot = {
  name: string;
  savedName: string;
  instruction: string;
  savedInstruction: string;
  trigger: RoutineTrigger;
  savedTrigger: RoutineTrigger;
  enabled: boolean;
};

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
 * call notes is offered only when this tenant has Granola connected (CL-6759)
 * — an unconnected plugin must never look like a working trigger; Slack is
 * offered only when this deployment's Slack tag ingress is actually mounted
 * (see `deployment-capabilities-api.ts`) — an unconfigured deployment must
 * never offer a trigger that can't honestly fire. A probe failure is not the
 * same as unconfigured (CL-6835): the affordance stays offered rather than
 * vanishing with no error.
 */
function AddTriggerMenu({
  slackAvailable,
  granolaAvailable,
  onSchedule,
  onGranola,
  onSlack,
  disabled,
}: {
  readonly slackAvailable: boolean;
  readonly granolaAvailable: boolean;
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
        {granolaAvailable ? (
          <MenuItem onSelect={onGranola}>Granola call notes</MenuItem>
        ) : null}
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
  const capabilities = useDeploymentCapabilities();
  const slackAvailable = slackTriggerOffered(capabilities);
  const granolaConnected = useGranolaPluginConnected(tenantId);
  const queryClient = useQueryClient();

  const invalidateRoutines = () => {
    if (tenantId === null) return;
    invalidateRoutineQueries(queryClient, tenantId);
  };

  const [routineId, setRoutineId] = useState<string | null>(
    subject.routineId ?? null,
  );
  const [name, setName] = useState("");
  const [savedName, setSavedName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [savedInstruction, setSavedInstruction] = useState("");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [savedTrigger, setSavedTrigger] = useState<RoutineTrigger>(null);
  const [triggerSourceLabel, setTriggerSourceLabel] = useState<string | null>(
    null,
  );
  const [addingSchedule, setAddingSchedule] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<readonly RoutineRun[]>([]);
  const [targetAssetId, setTargetAssetId] = useState<string | null>(null);
  const [existingTarget, setExistingTarget] = useState<RoutineTarget | null>(
    null,
  );

  // Every write (create or update) this panel session makes runs through
  // this one chain — never two in flight at once. `routineIdRef` is the
  // decision the chained tasks read: it only updates once a write actually
  // resolves, so a second commit queued before the first finished sees the
  // *post*-first-write id, not a stale snapshot from before either ran.
  const routineIdRef = useRef<string | null>(routineId);
  const targetAssetIdRef = useRef<string | null>(targetAssetId);
  targetAssetIdRef.current = targetAssetId;
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const draftRef = useRef<DraftSnapshot>({
    name: "",
    savedName: "",
    instruction: "",
    savedInstruction: "",
    trigger: null,
    savedTrigger: null,
    enabled: false,
  });
  draftRef.current = {
    name,
    savedName,
    instruction,
    savedInstruction,
    trigger,
    savedTrigger,
    enabled,
  };

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
    setSavedTrigger(null);
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    setEnabled(false);
    setSaveState("idle");
    setError(null);
    setRuns([]);
    setTargetAssetId(null);
    setExistingTarget(null);
  }, [subject]);

  const loadRuns = (id: string) => {
    if (tenantId === null) return;
    void listRoutineRuns(tenantId, id).then(
      (loaded) => setRuns(loaded),
      () => setRuns([]),
    );
  };

  /** First load of an existing routine — replace the whole draft. */
  const hydrateRoutine = (routine: Routine) => {
    setRoutineId(routine.id);
    routineIdRef.current = routine.id;
    setName(routine.name);
    setSavedName(routine.name);
    const loadedInstruction = instructionFromInput(routine.input);
    setInstruction(loadedInstruction);
    setSavedInstruction(loadedInstruction);
    setTrigger(routine.trigger);
    setSavedTrigger(routine.trigger);
    setEnabled(routine.enabled);
    setTargetAssetId(routine.definitionAssetId);
    draftRef.current = {
      name: routine.name,
      savedName: routine.name,
      instruction: loadedInstruction,
      savedInstruction: loadedInstruction,
      trigger: routine.trigger,
      savedTrigger: routine.trigger,
      enabled: routine.enabled,
    };
  };

  /** After a create/update resolves: refresh saved-* bookkeeping and the
   * routine id, but leave any still-dirty draft field alone so an in-flight
   * name create cannot wipe instruction/schedule the user typed meanwhile
   * (CL-6755). */
  const ackRoutine = (routine: Routine) => {
    const draft = draftRef.current;
    const loadedInstruction = instructionFromInput(routine.input);

    setRoutineId(routine.id);
    routineIdRef.current = routine.id;

    if (draft.name.trim() === draft.savedName) {
      setName(routine.name);
      draft.name = routine.name;
    }
    if (draft.instruction.trim() === draft.savedInstruction) {
      setInstruction(loadedInstruction);
      draft.instruction = loadedInstruction;
    }
    if (triggersEqual(draft.trigger, draft.savedTrigger)) {
      setTrigger(routine.trigger);
      draft.trigger = routine.trigger;
    }

    setSavedName(routine.name);
    setSavedInstruction(loadedInstruction);
    setSavedTrigger(routine.trigger);
    setEnabled(routine.enabled);
    draft.savedName = routine.name;
    draft.savedInstruction = loadedInstruction;
    draft.savedTrigger = routine.trigger;
    draft.enabled = routine.enabled;
  };

  // Loads an existing routine's real fields once the tenant resolves —
  // mirrors `ProfileCanvasPane`'s own "fetch once open" effect.
  useEffect(() => {
    if (tenantId === null || subject.routineId == null) return;
    let cancelled = false;
    void getRoutine(tenantId, subject.routineId).then(
      (routine) => {
        if (cancelled) return;
        hydrateRoutine(routine);
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

  // Existing-routine mode shows the current target's display name,
  // read-only for this issue — editing it is CL-7358. A stale target (no
  // longer in the tenant's deployable list) is shown honestly as its raw
  // id rather than hidden.
  useEffect(() => {
    if (tenantId === null || subject.routineId == null) return;
    let cancelled = false;
    void listAllRoutineTargets(tenantId).then(
      (targets) => {
        if (cancelled) return;
        setExistingTarget(
          targets.find((t) => t.definitionAssetId === targetAssetId) ?? null,
        );
      },
      () => {
        if (!cancelled) setExistingTarget(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tenantId, subject.routineId, targetAssetId]);

  /** This routine's delivery workbench: the conversation the panel was
   * opened beside (its own id), or, with no conversation in scope, this
   * workbench's own default Myra workbench. Never mints a new workbench —
   * `ensureMyraWorkbench` finds-or-creates the one singleton Myra
   * conversation this tenant already has. Delivery is independent of what
   * the routine runs (CL-7355) — that's `targetAssetId`, picked explicitly. */
  const resolveDeliveryWorkbenchId = async (): Promise<string> => {
    if (tenantId === null) {
      throw new Error("No workbench to create this in yet");
    }
    if (subject.workbenchId !== undefined) return subject.workbenchId;
    const result = await ensureMyraWorkbench(tenantId);
    if (result.kind === "error") throw new Error(result.message);
    return result.workbenchId;
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
        ackRoutine(routine);
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
    const definitionAssetId = targetAssetIdRef.current;
    if (definitionAssetId === null) {
      throw new Error("Pick what this routine runs before saving.");
    }
    const deliveryWorkbenchId = await resolveDeliveryWorkbenchId();
    const routine = await createRoutine(tenantId as string, {
      name: fields.name,
      definitionAssetId,
      deliveryWorkbenchId,
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
  // A brand-new routine requires a picked target before its first write can
  // fire at all (CL-7355) — a blur with no target selected yet is not a
  // failed save, it's simply not ready to submit.
  const commitName = () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (routineIdRef.current !== null && trimmed === savedName) return;
    if (routineIdRef.current === null && targetAssetIdRef.current === null) return;
    void runWrite((id) => {
      if (id === null) return doCreate({ name: trimmed, instruction, trigger });
      return updateRoutine(tenantId as string, id, { name: trimmed });
    });
  };

  const commitInstruction = () => {
    const trimmed = instruction.trim();
    if (routineIdRef.current === null && name.trim() === "") return;
    if (routineIdRef.current !== null && trimmed === savedInstruction) return;
    if (routineIdRef.current === null && targetAssetIdRef.current === null) return;
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
    draftRef.current.trigger = next;
    setTriggerSourceLabel(null);
    setAddingSchedule(false);
    if (routineIdRef.current === null && targetAssetIdRef.current === null) return;
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

  // Picking a target never itself submits — it only clears the "no target
  // yet" bail-out so the next field blur (Name/Instruction) can create.
  // `targetAssetIdRef` is set synchronously here so a blur landing in the
  // very same tick already sees the pick, not a stale pre-render snapshot.
  const pickTarget = (definitionAssetId: string) => {
    targetAssetIdRef.current = definitionAssetId;
    setTargetAssetId(definitionAssetId);
  };

  const removeTrigger = () => {
    setTrigger(null);
    draftRef.current.trigger = null;
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
      let definitionAssetId: string;
      if (targetRoutineId === null) {
        const created = await doCreate({
          name: name.trim() || "Untitled routine",
          instruction,
          trigger: null,
        });
        targetRoutineId = created.id;
        definitionAssetId = created.definitionAssetId;
      } else {
        const existing = targetAssetIdRef.current;
        if (existing === null) {
          throw new Error("Pick what this routine runs before saving.");
        }
        definitionAssetId = existing;
      }
      const binding = await createWebhookTrigger(tenantId, {
        name: `${name.trim() || "Untitled routine"} — ${sourceLabel}`,
        workflowDefinitionId: definitionAssetId,
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
            onChange={(event) => {
              setName(event.target.value);
              draftRef.current.name = event.target.value;
            }}
            onBlur={commitName}
          />
        </div>

        {routineId === null ? (
          <DefinitionTargetPicker
            tenantId={tenantId}
            value={targetAssetId}
            onChange={pickTarget}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium">
              What this routine runs
            </span>
            <div className="rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] px-2.5 py-1.5 text-sm">
              {existingTarget?.name ?? targetAssetId ?? "—"}
            </div>
          </div>
        )}

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
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
              setInstruction(event.target.value);
              draftRef.current.instruction = event.target.value;
            }}
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
              slackAvailable={slackAvailable}
              granolaAvailable={granolaConnected}
              disabled={false}
              onSchedule={() => setAddingSchedule(true)}
              onGranola={() => addWebhookTrigger("Granola call notes")}
              onSlack={() => addWebhookTrigger("Slack")}
            />
          ) : trigger === null && addingSchedule ? (
            <ScheduleEditor value={null} onChange={commitSchedule} />
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
              <ScheduleEditor value={trigger} onChange={commitSchedule} />
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
