// Routines: named automations over workflow runs.
// Layout matches the shell mock — col2 search + simple list (name, when,
// ON/OFF); detail is calm (steps, three recent runs, All runs & traces).
// New routine is two-path: from catalog (immediate) or describe-to-agent
// (draft → review → approve). Delivery channel is required on create.
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  formatRelativeTime,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  RichEmptyState,
  RunNowButton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import type { Channel } from "@corbits/chat-ui";
import { listChannels } from "@corbits/chat-ui";
import { Clock, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAPIQuery, RunsSchema } from "../api";
import type { APIQuery, WorkflowRun } from "../api";
import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";
import { QueryView } from "../query-view";
import { cadenceLabel } from "../routine-trigger";
import {
  approveRoutineDraft,
  createRoutine,
  createRoutineDraft,
  discardRoutineDraft,
  listRoutineRuns,
  listRoutines,
  listWorkflowDefinitions,
  routineCreatedToast,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
  useTenantQuery,
} from "../routines-api";
import type {
  CreateDraftInput,
  CreateRoutineInput,
  Routine,
  RoutineDraft,
  RoutineRun,
  RoutineTrigger,
  WorkflowDefinitionSummary,
} from "../routines-api";

const ROUTINES_PATH_PREFIX = "/routines";

function routineIdFromPath(path: string): string | null {
  if (!path.startsWith(`${ROUTINES_PATH_PREFIX}/`)) return null;
  const rest = path.slice(ROUTINES_PATH_PREFIX.length + 1);
  return rest === "" ? null : decodeURIComponent(rest);
}

const RUN_STATUS_TONE: Record<string, BadgeTone> = {
  running: "success",
  completed: "info",
  failed: "danger",
  cancelled: "neutral",
};

/** One calm sentence under the routine name; deliver-to only when known. */
function routineDetailSentence(
  routine: Routine,
  channels: readonly Channel[],
): string {
  const when = cadenceLabel(routine.trigger);
  const channel = channels.find((c) => c.id === routine.deliveryChannelId);
  if (channel !== undefined) {
    return `${when}, delivers to ${channel.title}.`;
  }
  return `${when}.`;
}

function draftedStepsFromInput(
  input: Record<string, unknown>,
): readonly { title: string; detail?: string }[] {
  const raw = input["draftedSteps"];
  if (!Array.isArray(raw)) return [];
  const steps: { title: string; detail?: string }[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record["title"] !== "string") continue;
    const step: { title: string; detail?: string } = {
      title: record["title"],
    };
    if (typeof record["detail"] === "string") step.detail = record["detail"];
    steps.push(step);
  }
  return steps;
}

type TriggerKind = "manual" | "interval" | "daily" | "weekly" | "cron";

function TriggerPicker({
  value,
  onChange,
}: {
  readonly value: RoutineTrigger;
  readonly onChange: (next: RoutineTrigger) => void;
}) {
  const kind: TriggerKind = value === null ? "manual" : value.kind;

  const setKind = (next: TriggerKind) => {
    switch (next) {
      case "manual":
        onChange(null);
        return;
      case "interval":
        onChange({ kind: "interval", unit: "minutes", every: 15 });
        return;
      case "daily":
        onChange({ kind: "daily", hour: 9, minute: 0 });
        return;
      case "weekly":
        onChange({ kind: "weekly", dayOfWeek: 1, hour: 9, minute: 0 });
        return;
      case "cron":
        onChange({ kind: "cron", expression: "0 9 * * *" });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span id="routine-cadence-label" className="text-xs font-medium">
        Cadence
      </span>
      <Menu>
        <MenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            id="routine-cadence"
            aria-labelledby="routine-cadence-label"
          >
            {
              {
                manual: "Manual (run only when triggered)",
                interval: "Every N minutes/hours",
                daily: "Daily",
                weekly: "Weekly",
                cron: "Raw cron expression",
              }[kind]
            }
          </Button>
        </MenuTrigger>
        <MenuContent>
          {(
            [
              ["manual", "Manual (run only when triggered)"],
              ["interval", "Every N minutes/hours"],
              ["daily", "Daily"],
              ["weekly", "Weekly"],
              ["cron", "Raw cron expression"],
            ] as const
          ).map(([option, label]) => (
            <MenuItem key={option} onSelect={() => setKind(option)}>
              {label}
            </MenuItem>
          ))}
        </MenuContent>
      </Menu>

      {value !== null && value.kind === "interval" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--ui-fg-muted)]">Every</span>
          <Input
            type="number"
            min={1}
            value={value.every}
            onChange={(event) =>
              onChange({
                ...value,
                every: Math.max(1, Math.trunc(event.target.valueAsNumber) || 1),
              })
            }
          />
          <Menu>
            <MenuTrigger asChild>
              <Button type="button" variant="outline" size="sm">
                {value.unit}
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem
                onSelect={() => onChange({ ...value, unit: "minutes" })}
              >
                minutes
              </MenuItem>
              <MenuItem onSelect={() => onChange({ ...value, unit: "hours" })}>
                hours
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      ) : null}

      {value !== null && (value.kind === "daily" || value.kind === "weekly") ? (
        <div className="flex flex-wrap items-center gap-2">
          {value.kind === "weekly" ? (
            <Menu>
              <MenuTrigger asChild>
                <Button type="button" variant="outline" size="sm">
                  {
                    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                      value.dayOfWeek
                    ]
                  }
                </Button>
              </MenuTrigger>
              <MenuContent>
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                  (label, index) => (
                    <MenuItem
                      key={label}
                      onSelect={() => onChange({ ...value, dayOfWeek: index })}
                    >
                      {label}
                    </MenuItem>
                  ),
                )}
              </MenuContent>
            </Menu>
          ) : null}
          <span className="text-xs text-[var(--ui-fg-muted)]">At</span>
          <Input
            type="time"
            value={`${value.hour.toString().padStart(2, "0")}:${value.minute.toString().padStart(2, "0")}`}
            onChange={(event) => {
              const [hour, minute] = event.target.value.split(":").map(Number);
              onChange({
                ...value,
                hour: hour ?? 0,
                minute: minute ?? 0,
              });
            }}
          />
          <span className="text-xs text-[var(--ui-fg-muted)]">UTC</span>
        </div>
      ) : null}

      {value !== null && value.kind === "cron" ? (
        <Input
          value={value.expression}
          placeholder="0 9 * * *"
          onChange={(event) =>
            onChange({ kind: "cron", expression: event.target.value })
          }
        />
      ) : null}
    </div>
  );
}

function DeliveryChannelPicker({
  channels,
  value,
  onChange,
  disabled,
}: {
  readonly channels: readonly Channel[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly disabled?: boolean;
}) {
  const selected = channels.find((c) => c.id === value);
  if (channels.length === 0) {
    return (
      <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
        No delivery channel on this bench yet — create a channel first.
      </p>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          id="routine-delivery"
        >
          {selected?.title ?? "Choose channel"}
        </Button>
      </MenuTrigger>
      <MenuContent>
        {channels.map((channel) => (
          <MenuItem key={channel.id} onSelect={() => onChange(channel.id)}>
            {channel.title}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

type CreatePath = "catalog" | "describe";
type CreateStage = "compose" | "review";

/** Readable autonomy lines for the draft review panel (pure for tests). */
export function autonomyReviewLines(
  autonomy: Record<string, unknown> | null,
): readonly string[] {
  if (autonomy === null) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(autonomy)) {
    if (value === null || value === undefined) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines;
}

function CreateRoutineDialog({
  definitions,
  channels,
  onCreate,
  onDescribe,
  onApproveDraft,
  onDiscardDraft,
  open: openProp,
  onOpenChange,
}: {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly channels: readonly Channel[];
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
  readonly onDescribe: (input: CreateDraftInput) => Promise<RoutineDraft>;
  readonly onApproveDraft: (draftId: string) => Promise<void>;
  readonly onDiscardDraft: (draftId: string) => Promise<void>;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const [path, setPath] = useState<CreatePath>("catalog");
  const [stage, setStage] = useState<CreateStage>("compose");
  const [name, setName] = useState("");
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? "");
  const [runMode, setRunMode] = useState<"once" | "schedule">("once");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [prompt, setPrompt] = useState("");
  const [deliveryChannelId, setDeliveryChannelId] = useState(
    channels[0]?.id ?? "",
  );
  const [pendingDraft, setPendingDraft] = useState<RoutineDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (deliveryChannelId === "" && channels[0] !== undefined) {
      setDeliveryChannelId(channels[0].id);
    }
  }, [channels, deliveryChannelId]);

  useEffect(() => {
    if (definitionId === "" && definitions[0] !== undefined) {
      setDefinitionId(definitions[0].id);
    }
  }, [definitions, definitionId]);

  const catalogComplete =
    name.trim().length > 0 && definitionId !== "" && deliveryChannelId !== "";
  const describeComplete = prompt.trim().length > 0 && deliveryChannelId !== "";
  const complete = path === "catalog" ? catalogComplete : describeComplete;

  const reset = () => {
    setPath("catalog");
    setStage("compose");
    setName("");
    setDefinitionId(definitions[0]?.id ?? "");
    setRunMode("once");
    setTrigger(null);
    setPrompt("");
    setDeliveryChannelId(channels[0]?.id ?? "");
    setPendingDraft(null);
    setError(null);
  };

  const closeDialog = () => {
    setOpen(false);
    reset();
  };

  const cancelReview = () => {
    const draft = pendingDraft;
    setBusy(true);
    setError(null);
    const work = draft !== null ? onDiscardDraft(draft.id) : Promise.resolve();
    void work
      .catch(() => {
        // Discard best-effort; still leave the compose/review flow.
      })
      .finally(() => {
        setBusy(false);
        closeDialog();
      });
  };

  if (stage === "review" && pendingDraft !== null) {
    const draft = pendingDraft;
    const draftName =
      draft.proposedName !== null && draft.proposedName !== ""
        ? draft.proposedName
        : draft.prompt.slice(0, 80);
    const autonomyLines = autonomyReviewLines(draft.autonomy);

    return (
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            cancelReview();
            return;
          }
          setOpen(next);
        }}
      >
        {openProp === undefined ? (
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus /> New routine
          </Button>
        ) : null}
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Review draft</DialogTitle>
            <DialogDescription>
              Check the proposed steps, then approve to create the routine.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                Name
              </span>
              <p className="text-sm font-medium text-[var(--ui-fg)]">
                {draftName}
              </p>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                Proposed steps
              </span>
              {draft.proposedSteps.length === 0 ? (
                <p className="text-sm text-[var(--ui-fg-muted)]" role="status">
                  No steps proposed yet.
                </p>
              ) : (
                <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                  {draft.proposedSteps.map((step, index) => (
                    <li key={`${step.title}-${String(index)}`}>
                      <span className="font-medium">{step.title}</span>
                      {step.detail !== undefined ? (
                        <span className="text-[var(--ui-fg-muted)]">
                          {" — "}
                          {step.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {draft.proposedTrigger !== null ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                  Schedule
                </span>
                <p className="text-sm">{cadenceLabel(draft.proposedTrigger)}</p>
              </div>
            ) : null}

            {autonomyLines.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                  Autonomy
                </span>
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-[var(--ui-fg-muted)]">
                  {autonomyLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <p className="text-xs text-[var(--ui-fg-muted)]">
              From: {draft.prompt}
            </p>

            {error !== null ? (
              <p className="text-xs text-[var(--ui-danger)]" role="alert">
                {error}
              </p>
            ) : null}

            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => cancelReview()}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  void onApproveDraft(draft.id)
                    .then(() => {
                      closeDialog();
                    })
                    .catch((cause: unknown) => {
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    })
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Approving…" : "Approve"}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      {openProp === undefined ? (
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus /> New routine
        </Button>
      ) : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New routine</DialogTitle>
          <DialogDescription>
            From the catalog for something known, or describe it to an agent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!complete) return;
            setBusy(true);
            setError(null);
            if (path === "catalog") {
              void onCreate({
                name: name.trim(),
                definitionId,
                scope: "bench",
                deliveryChannelId,
                trigger: runMode === "once" ? null : trigger,
                runOnceNow: runMode === "once",
              })
                .then(() => {
                  closeDialog();
                })
                .catch((cause: unknown) => {
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                })
                .finally(() => setBusy(false));
              return;
            }
            void onDescribe({
              prompt: prompt.trim(),
              deliveryChannelId,
              scope: "bench",
            })
              .then((draft) => {
                setPendingDraft(draft);
                setStage("review");
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <div className="flex gap-1 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] p-0.5">
            {(
              [
                ["catalog", "From catalog"],
                ["describe", "Describe to agent"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                onClick={() => setPath(value)}
                className={[
                  "flex-1 rounded-[var(--ui-radius-sm)] px-2 py-1.5 text-xs font-medium transition-colors",
                  path === value
                    ? "bg-[var(--ui-accent)] text-[var(--ui-accent-fg)]"
                    : "text-[var(--ui-fg-muted)] hover:bg-[var(--ui-bg-muted)]",
                ].join(" ")}
              >
                {label}
              </button>
            ))}
          </div>

          {path === "catalog" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="routine-name" className="text-xs font-medium">
                  Name
                </label>
                <Input
                  id="routine-name"
                  value={name}
                  placeholder="Morning brief"
                  required
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span
                  id="routine-definition-label"
                  className="text-xs font-medium"
                >
                  Workflow
                </span>
                {definitions.length === 0 ? (
                  <p
                    className="text-xs text-[var(--ui-fg-muted)]"
                    role="status"
                  >
                    No automatable workflows on this bench yet.
                  </p>
                ) : (
                  <Menu>
                    <MenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        id="routine-definition"
                        aria-labelledby="routine-definition-label"
                        disabled={busy}
                      >
                        {definitions.find((d) => d.id === definitionId)?.name ??
                          "Choose workflow"}
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      {definitions.map((definition) => (
                        <MenuItem
                          key={definition.id}
                          onSelect={() => setDefinitionId(definition.id)}
                        >
                          {definition.name}
                        </MenuItem>
                      ))}
                    </MenuContent>
                  </Menu>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">When</span>
                <div className="flex gap-1">
                  {(
                    [
                      ["once", "Run once now"],
                      ["schedule", "On a schedule"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      disabled={busy}
                      onClick={() => setRunMode(value)}
                      className={[
                        "rounded-[var(--ui-radius-sm)] border px-2 py-1 text-xs",
                        runMode === value
                          ? "border-[var(--ui-accent)] bg-[var(--ui-accent-soft)]"
                          : "border-[var(--ui-border)]",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {runMode === "schedule" ? (
                  <TriggerPicker value={trigger} onChange={setTrigger} />
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="routine-prompt" className="text-xs font-medium">
                Describe the routine
              </label>
              <textarea
                id="routine-prompt"
                value={prompt}
                disabled={busy}
                rows={4}
                placeholder="Every weekday at 9am, pull the signups export and post a summary to #ops."
                onChange={(event) => setPrompt(event.target.value)}
                className="w-full resize-y rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg)] px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-ring)]"
              />
              <p className="text-xs text-[var(--ui-fg-muted)]">
                An agent drafts the steps; you review and approve before it
                runs.
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span id="routine-delivery-label" className="text-xs font-medium">
              Deliver results to
            </span>
            <DeliveryChannelPicker
              channels={channels}
              value={deliveryChannelId}
              onChange={setDeliveryChannelId}
              disabled={busy}
            />
          </div>

          {error !== null ? (
            <p className="text-xs text-[var(--ui-danger)]" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={busy || !complete}>
              {busy
                ? path === "catalog"
                  ? "Creating…"
                  : "Drafting…"
                : path === "catalog"
                  ? "Create routine"
                  : "Draft with agent"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RunsTable({
  runs,
  now,
  emptyTitle,
  emptyDescription,
}: {
  readonly runs: readonly RoutineRun[];
  readonly now: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
}) {
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={<Clock />}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Triggered by</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run) => {
          const status = run.run?.status;
          return (
            <TableRow key={run.runId}>
              <TableCell>
                <Badge tone="neutral">{run.triggeredBy}</Badge>
              </TableCell>
              <TableCell>
                {typeof status === "string" ? (
                  <Badge tone={RUN_STATUS_TONE[status] ?? "neutral"}>
                    {status}
                  </Badge>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>{formatRelativeTime(run.createdAt, now)}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function RoutinesListPage({
  routines,
  runHistories,
  liveRuns: _liveRuns,
  now = Date.now(),
  definitions,
  channels,
  selectedId,
  onSelect: _onSelect,
  onCreate,

  onDescribe,
  onApproveDraft,
  onDiscardDraft,
  onToggleEnabled,
  onRunNow,
}: {
  readonly routines: APIQuery<readonly Routine[]>;
  readonly runHistories: ReadonlyMap<string, readonly RoutineRun[]>;
  readonly liveRuns: APIQuery<readonly WorkflowRun[]>;
  readonly now?: number;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly channels: readonly Channel[];
  readonly selectedId: string | null;
  readonly onSelect: (routineId: string | null) => void;
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
  readonly onDescribe: (input: CreateDraftInput) => Promise<RoutineDraft>;
  readonly onApproveDraft: (draftId: string) => Promise<void>;
  readonly onDiscardDraft: (draftId: string) => Promise<void>;
  readonly onToggleEnabled: (routine: Routine, enabled: boolean) => void;
  readonly onRunNow: (routine: Routine) => Promise<void>;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);

  useEffect(() => {
    const onCreateEvent = () => setCreateOpen(true);
    window.addEventListener("workbench:routines:create", onCreateEvent);
    return () =>
      window.removeEventListener("workbench:routines:create", onCreateEvent);
  }, []);

  useEffect(() => {
    setShowAllRuns(false);
  }, [selectedId]);

  const selected =
    routines.kind === "ready" && selectedId !== null
      ? (routines.data.find((r) => r.id === selectedId) ?? null)
      : null;
  const selectedRuns =
    selectedId !== null ? (runHistories.get(selectedId) ?? []) : [];
  const recentRuns = selectedRuns.slice(0, 3);
  const steps = selected !== null ? draftedStepsFromInput(selected.input) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <CreateRoutineDialog
        definitions={definitions}
        channels={channels}
        onCreate={onCreate}
        onDescribe={onDescribe}
        onApproveDraft={onApproveDraft}
        onDiscardDraft={onDiscardDraft}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />

      {/* List lives in shell col2; stage is detail only. Create is
          pageBand / workbench:routines:create — no stage chrome header. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selected === null ? (
          <div className="flex flex-1 items-center justify-center p-6">
            {routines.kind === "ready" && routines.data.length === 0 ? (
              <RichEmptyState
                icon={<Clock />}
                title="No routines yet"
                description="Create one from a workflow or a prompt."
                actions={[
                  {
                    label: "New routine",
                    onClick: () => setCreateOpen(true),
                    variant: "primary",
                  },
                ]}
              />
            ) : (
              <EmptyState
                icon={<Clock />}
                title="Select a routine"
                description="Pick a routine from the sidebar to see its steps and recent runs."
              />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--ui-border)] px-4 py-3">
              <div className="min-w-0">
                <h2 className="truncate text-base font-semibold text-[var(--ui-fg)]">
                  {selected.name}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--ui-fg-muted)]">
                  {routineDetailSentence(selected, channels)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={selected.enabled}
                  label={`${selected.enabled ? "Pause" : "Resume"} ${selected.name}`}
                  onCheckedChange={(enabled) =>
                    onToggleEnabled(selected, enabled)
                  }
                />
                <RunNowButton
                  variant="outline"
                  size="sm"
                  onRun={() => onRunNow(selected)}
                />
              </div>
            </div>

            <section className="border-b border-[var(--ui-border)] px-4 py-3">
              <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                Steps
              </h3>
              {steps.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">
                  Runs workflow{" "}
                  <span className="font-medium text-[var(--ui-fg)]">
                    {definitions.find((d) => d.id === selected.definitionId)
                      ?.name ?? "selected definition"}
                  </span>
                  .
                </p>
              ) : (
                <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">
                  {steps.map((step, index) => (
                    <li key={`${step.title}-${index}`}>
                      <span className="font-medium">{step.title}</span>
                      {step.detail !== undefined ? (
                        <span className="text-[var(--ui-fg-muted)]">
                          {" — "}
                          {step.detail}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                  {showAllRuns ? "All runs & traces" : "Recent runs"}
                </h3>
                {selectedRuns.length > 3 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllRuns((v) => !v)}
                  >
                    {showAllRuns ? "Show three" : "All runs & traces"}
                  </Button>
                ) : null}
              </div>
              <RunsTable
                runs={showAllRuns ? selectedRuns : recentRuns}
                now={now}
                emptyTitle="No runs yet"
                emptyDescription="This routine has not fired yet — manually or on a schedule."
              />
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export function RoutineDetailPage({
  routine,
  runs,
  onBack,
  now = Date.now(),
  definitions = [],
}: {
  readonly routine: APIQuery<Routine>;
  readonly runs: APIQuery<readonly RoutineRun[]>;
  readonly onBack: () => void;
  readonly now?: number;
  readonly definitions?: readonly WorkflowDefinitionSummary[];
}) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--ui-border)] px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <h2 className="text-sm font-semibold">
          {routine.kind === "ready" ? routine.data.name : "Routine"}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <QueryView query={routine} label="this routine">
          {(data) => {
            const steps = draftedStepsFromInput(data.input);
            return (
              <div className="flex flex-col gap-4">
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-[var(--ui-fg-muted)]">Cadence</dt>
                  <dd>{cadenceLabel(data.trigger)}</dd>
                  <dt className="text-[var(--ui-fg-muted)]">Status</dt>
                  <dd>
                    <Badge tone={data.enabled ? "success" : "neutral"}>
                      {data.enabled ? "On" : "Off"}
                    </Badge>
                  </dd>
                </dl>
                <section>
                  <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                    Steps
                  </h3>
                  {steps.length === 0 ? (
                    <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">
                      Runs workflow{" "}
                      {definitions.find((d) => d.id === data.definitionId)
                        ?.name ?? "selected definition"}
                      .
                    </p>
                  ) : (
                    <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm">
                      {steps.map((step, index) => (
                        <li key={`${step.title}-${index}`}>
                          <span className="font-medium">{step.title}</span>
                          {step.detail !== undefined ? (
                            <span className="text-[var(--ui-fg-muted)]">
                              {" — "}
                              {step.detail}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>
            );
          }}
        </QueryView>

        <section className="mt-6" aria-label="Run history">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
              {showAll ? "All runs & traces" : "Recent runs"}
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowAll((v) => !v)}
            >
              {showAll ? "Show three" : "All runs & traces"}
            </Button>
          </div>
          <QueryView query={runs} label="this routine's run history">
            {(items) => (
              <RunsTable
                runs={showAll ? items : items.slice(0, 3)}
                now={now}
                emptyTitle="No runs yet"
                emptyDescription="This routine has not fired yet — manually or on a schedule."
              />
            )}
          </QueryView>
        </section>
      </div>
    </div>
  );
}

function routineRunIds(
  runHistories: ReadonlyMap<string, readonly RoutineRun[]>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const runs of runHistories.values()) {
    for (const run of runs) ids.add(run.runId);
  }
  return ids;
}

export function RoutinesRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const allRuns = useAPIQuery("/api/me/workflows/runs", RunsSchema);
  const tenantId = selectedTenantId;

  function invalidateRoutines() {
    if (tenantId === null) return;
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routines(tenantId),
    });
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.routineRunHistories(tenantId),
    });
  }

  const routines = useTenantQuery(
    tenantId === null
      ? (["tenant", "none", "routines"] as const)
      : tenantKeys.routines(tenantId),
    tenantId !== null,
    () => listRoutines(tenantId ?? ""),
  );
  const definitionsQuery = useTenantQuery(
    tenantId === null
      ? (["tenant", "none", "definitions"] as const)
      : tenantKeys.definitions(tenantId),
    tenantId !== null,
    () => listWorkflowDefinitions(tenantId ?? ""),
  );
  const definitions =
    definitionsQuery.kind === "ready" ? definitionsQuery.data : [];

  const channelsQuery = useTenantQuery(
    tenantId === null
      ? (["tenant", "none", "channels-for-routines"] as const)
      : (["tenant", tenantId, "channels-for-routines"] as const),
    tenantId !== null,
    () => listChannels(tenantId ?? "", "channel"),
  );
  const channels = channelsQuery.kind === "ready" ? channelsQuery.data : [];

  const routineIds =
    routines.kind === "ready" ? routines.data.map((r) => r.id) : [];
  const runHistoriesQuery = useTenantQuery<
    ReadonlyMap<string, readonly RoutineRun[]>
  >(
    tenantId === null
      ? (["tenant", "none", "routine-run-histories"] as const)
      : [...tenantKeys.routineRunHistories(tenantId), routineIds.join(",")],
    tenantId !== null && routineIds.length > 0,
    async () => {
      const entries = await Promise.all(
        routineIds.map(
          async (id) =>
            [id, await listRoutineRuns(tenantId ?? "", id)] as const,
        ),
      );
      return new Map(entries);
    },
  );
  const runHistories =
    runHistoriesQuery.kind === "ready" ? runHistoriesQuery.data : new Map();

  const liveRuns: APIQuery<readonly WorkflowRun[]> =
    allRuns.kind === "ready"
      ? {
          kind: "ready",
          data: allRuns.data.data.filter((run) =>
            routineRunIds(runHistories).has(run.id),
          ),
        }
      : allRuns;

  const openRoutineId = routineIdFromPath(path);

  // Mock master-detail: bare /routines with a non-empty list opens the first.
  useEffect(() => {
    if (openRoutineId !== null) return;
    if (routines.kind !== "ready" || routines.data.length === 0) return;
    const first = routines.data[0];
    if (first === undefined) return;
    navigate(`${ROUTINES_PATH_PREFIX}/${encodeURIComponent(first.id)}`);
  }, [openRoutineId, routines, navigate]);

  // Mobile full-page detail when deep-linked; desktop uses the split pane.
  const isNarrow =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches;

  const detailRoutine: APIQuery<Routine> = useMemo(() => {
    if (openRoutineId === null || tenantId === null) {
      return { kind: "loading" };
    }
    if (routines.kind === "loading") return { kind: "loading" };
    if (routines.kind !== "ready") return routines;
    const found = routines.data.find((r) => r.id === openRoutineId);
    if (found === undefined) {
      return { kind: "error", message: "Routine not found" };
    }
    return { kind: "ready", data: found };
  }, [openRoutineId, tenantId, routines]);

  const detailRuns = useTenantQuery(
    tenantId === null || openRoutineId === null
      ? (["tenant", "none", "routines", "none", "runs"] as const)
      : tenantKeys.routineRuns(tenantId, openRoutineId),
    tenantId !== null && openRoutineId !== null,
    () => listRoutineRuns(tenantId ?? "", openRoutineId ?? ""),
  );

  if (openRoutineId !== null && isNarrow) {
    return (
      <RoutineDetailPage
        routine={detailRoutine}
        runs={detailRuns}
        definitions={definitions}
        onBack={() => navigate(ROUTINES_PATH_PREFIX)}
      />
    );
  }

  return (
    <RoutinesListPage
      routines={
        routines.kind === "ready"
          ? { kind: "ready", data: routines.data }
          : routines
      }
      runHistories={runHistories}
      liveRuns={liveRuns}
      definitions={definitions}
      channels={channels}
      selectedId={openRoutineId}
      onSelect={(id) =>
        navigate(
          id === null
            ? ROUTINES_PATH_PREFIX
            : `${ROUTINES_PATH_PREFIX}/${encodeURIComponent(id)}`,
        )
      }
      onCreate={async (input) => {
        if (tenantId === null)
          throw new Error("No bench to create this in yet");
        await createRoutine(tenantId, input);
        invalidateRoutines();
        toast(routineCreatedToast(input.name));
      }}
      onDescribe={async (input) => {
        if (tenantId === null) throw new Error("No bench to draft this in yet");
        return createRoutineDraft(tenantId, input);
      }}
      onApproveDraft={async (draftId) => {
        if (tenantId === null)
          throw new Error("No bench to approve this draft in yet");
        const result = await approveRoutineDraft(tenantId, draftId);
        invalidateRoutines();
        navigate(
          `${ROUTINES_PATH_PREFIX}/${encodeURIComponent(result.routine.id)}`,
        );
      }}
      onDiscardDraft={async (draftId) => {
        if (tenantId === null) return;
        await discardRoutineDraft(tenantId, draftId);
      }}
      onToggleEnabled={(routine, enabled) => {
        if (tenantId === null) return;
        void updateRoutine(tenantId, routine.id, { enabled }).then(
          invalidateRoutines,
        );
      }}
      onRunNow={async (routine) => {
        if (tenantId === null) throw new Error("No bench to run this on yet");
        await runRoutineNow(tenantId, routine.id);
        invalidateRoutines();
        toast(routineRunStartedToast(routine.name));
      }}
    />
  );
}
