// The Routines screen: named automations over workflow runs. Follows
// runs-page.tsx / library-page.tsx's shape (pure `*Page` components fed
// `APIQuery` props, a `*Route` container that resolves data). The active
// bench comes from `useBench()` — the shell's one source of truth — never
// a page-local `/api/me/principals` fetch that ignores the switcher.
//
// The create flow's trigger picker is workbench-specific composition
// (`RoutineTrigger`'s exact shape, including the raw-cron escape hatch)
// rather than `@corbits/react-ui`'s own `RecurrenceInput`: that
// component's `Recurrence` type deliberately excludes cron and a
// minutes unit (see its own doc comment), which a routine's trigger
// contract requires. Everything else — Table, Card, Badge, Dialog,
// Button, Input, Switch, RunNowButton — is reused as-is.
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
  DialogTrigger,
  EmptyState,
  formatRelativeTime,
  Input,
  PageShell,
  RunNowButton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TopBar,
  TopBarTitle,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Clock, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { RunsSchema, useAPIQuery } from "../api";
import type { APIQuery, WorkflowRun } from "../api";
import { useBench } from "../bench-context";
import { countProp } from "../optional-props";
import { tenantKeys } from "../query-client";

import { QueryView } from "../query-view";
import { approximateNextRun, cadenceLabel } from "../routine-trigger";
import {
  createRoutine,
  listRoutineRuns,
  listRoutines,
  listWorkflowDefinitions,
  runRoutineNow,
  updateRoutine,
  useTenantQuery,
} from "../routines-api";
import type {
  CreateRoutineInput,
  Routine,
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

function lastResultLabel(runs: readonly RoutineRun[]): string {
  const [latest] = runs;
  if (latest === undefined) return "Never run";
  const status = latest.run?.status;
  return typeof status === "string" ? status : "Started";
}

type TriggerKind = "manual" | "interval" | "daily" | "weekly" | "cron";

/**
 * The create flow's trigger editor, over `RoutineTrigger` directly —
 * every field it renders is exactly one this shape carries, so a save
 * never needs a translation step.
 */
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
    <div className="flex-col-gap">
      <label htmlFor="routine-cadence" className="form-label">
        Cadence
      </label>
      <select
        id="routine-cadence"
        value={kind}
        onChange={(event) => setKind(event.target.value as TriggerKind)}
      >
        <option value="manual">Manual (run only when triggered)</option>
        <option value="interval">Every N minutes/hours</option>
        <option value="daily">Daily</option>
        <option value="weekly">Weekly</option>
        <option value="cron">Raw cron expression</option>
      </select>

      {value !== null && value.kind === "interval" ? (
        <div className="form-row">
          <span>Every</span>
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
          <select
            value={value.unit}
            onChange={(event) =>
              onChange({
                ...value,
                unit: event.target.value as "minutes" | "hours",
              })
            }
          >
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
          </select>
        </div>
      ) : null}

      {value !== null && (value.kind === "daily" || value.kind === "weekly") ? (
        <div className="form-row">
          {value.kind === "weekly" ? (
            <select
              value={value.dayOfWeek}
              onChange={(event) =>
                onChange({ ...value, dayOfWeek: Number(event.target.value) })
              }
            >
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                (label, index) => (
                  <option key={label} value={index}>
                    {label}
                  </option>
                ),
              )}
            </select>
          ) : null}
          <span>At</span>
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
          <span className="form-hint">UTC</span>
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

function CreateRoutineDialog({
  definitions,
  onCreate,
}: {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [definitionId, setDefinitionId] = useState(definitions[0]?.id ?? "");
  const [runMode, setRunMode] = useState<"once" | "schedule">("once");
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = name.trim().length > 0 && definitionId !== "";

  const reset = () => {
    setName("");
    setDefinitionId(definitions[0]?.id ?? "");
    setRunMode("once");
    setTrigger(null);
    setError(null);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus /> New routine
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New routine</DialogTitle>
          <DialogDescription>
            Pick a workflow, then run it once or put it on a schedule.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex-col-gap"
          onSubmit={(event) => {
            event.preventDefault();
            if (!complete) return;
            setBusy(true);
            setError(null);
            void onCreate({
              name: name.trim(),
              definitionId,
              scope: "bench",
              trigger: runMode === "once" ? null : trigger,
            })
              .then(() => {
                setOpen(false);
                reset();
              })
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <div className="flex-col-gap">
            <label htmlFor="routine-name" className="form-label">
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

          <div className="flex-col-gap">
            <label htmlFor="routine-definition" className="form-label">
              Workflow
            </label>
            <select
              id="routine-definition"
              value={definitionId}
              disabled={busy || definitions.length === 0}
              onChange={(event) => setDefinitionId(event.target.value)}
            >
              {definitions.length === 0 ? (
                <option value="">No workflows available</option>
              ) : (
                definitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="flex-col-gap">
            <label htmlFor="routine-run-mode" className="form-label">
              When
            </label>
            <select
              id="routine-run-mode"
              value={runMode}
              disabled={busy}
              onChange={(event) =>
                setRunMode(event.target.value as "once" | "schedule")
              }
            >
              <option value="once">Run once, right now</option>
              <option value="schedule">On a schedule</option>
            </select>
          </div>

          {runMode === "schedule" ? (
            <TriggerPicker value={trigger} onChange={setTrigger} />
          ) : null}

          {error === null ? null : (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={busy || !complete}>
              {busy ? "Creating…" : "Create routine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RoutinesListPage({
  routines,
  runHistories,
  liveRuns,
  now = Date.now(),
  definitions,
  onOpen,
  onCreate,
  onToggleEnabled,
  onRunNow,
}: {
  readonly routines: APIQuery<readonly Routine[]>;
  /** Each routine's own run history, keyed by routine id — used for "last result". */
  readonly runHistories: ReadonlyMap<string, readonly RoutineRun[]>;
  readonly liveRuns: APIQuery<readonly WorkflowRun[]>;
  readonly now?: number;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly onOpen: (routineId: string) => void;
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
  readonly onToggleEnabled: (routine: Routine, enabled: boolean) => void;
  readonly onRunNow: (routine: Routine) => Promise<void>;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          {...countProp(
            routines.kind === "ready" ? routines.data.length : undefined,
          )}
          subtitle="Named automations that run a workflow on a schedule or on demand"
        >
          Routines
        </TopBarTitle>
        <CreateRoutineDialog definitions={definitions} onCreate={onCreate} />
      </TopBar>
      <PageShell className="page-fill">
        <QueryView query={routines} label="your routines">
          {(items) =>
            items.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title="No routines yet"
                description="Create a routine to run a workflow on a schedule or fire it manually whenever you need it."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Cadence</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Last result</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Enabled</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((routine) => {
                    const nextRun = routine.enabled
                      ? approximateNextRun(routine.trigger, new Date(now))
                      : null;
                    return (
                      <TableRow key={routine.id}>
                        <TableCell>
                          <button
                            type="button"
                            className="link-button"
                            onClick={() => onOpen(routine.id)}
                          >
                            {routine.name}
                          </button>
                        </TableCell>
                        <TableCell>{cadenceLabel(routine.trigger)}</TableCell>
                        <TableCell>
                          {nextRun === null
                            ? "—"
                            : formatRelativeTime(nextRun.toISOString(), now)}
                        </TableCell>
                        <TableCell>
                          {lastResultLabel(runHistories.get(routine.id) ?? [])}
                        </TableCell>
                        <TableCell>
                          <Badge tone="neutral">{routine.scope}</Badge>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={routine.enabled}
                            label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                            onCheckedChange={(enabled) =>
                              onToggleEnabled(routine, enabled)
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <RunNowButton
                            variant="outline"
                            size="sm"
                            onRun={() => onRunNow(routine)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )
          }
        </QueryView>

        <TopBar>
          <TopBarTitle subtitle="Runs currently executing that a routine started">
            Live runs
          </TopBarTitle>
        </TopBar>
        <QueryView query={liveRuns} label="live routine runs">
          {(runs) =>
            runs.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title="No routine runs in flight"
                description="When a routine fires, its run appears here while it executes."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Definition</TableHead>
                    <TableHead>Bench</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell>{run.definitionName}</TableCell>
                      <TableCell>{run.tenantName}</TableCell>
                      <TableCell>
                        <Badge tone={RUN_STATUS_TONE[run.status] ?? "neutral"}>
                          {run.status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {formatRelativeTime(run.createdAt, now)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )
          }
        </QueryView>
      </PageShell>
    </>
  );
}

export function RoutineDetailPage({
  routine,
  runs,
  onBack,
  now = Date.now(),
}: {
  readonly routine: APIQuery<Routine>;
  readonly runs: APIQuery<readonly RoutineRun[]>;
  readonly onBack: () => void;
  readonly now?: number;
}) {
  return (
    <>
      <TopBar>
        <TopBarTitle
          subtitle={
            routine.kind === "ready" ? cadenceLabel(routine.data.trigger) : ""
          }
        >
          {routine.kind === "ready" ? routine.data.name : "Routine"}
        </TopBarTitle>
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back to routines
        </Button>
      </TopBar>
      <PageShell width="prose" className="page-fill">
        <QueryView query={routine} label="this routine">
          {(data) => (
            <dl className="detail-list">
              <dt>Cadence</dt>
              <dd>{cadenceLabel(data.trigger)}</dd>
              <dt>Scope</dt>
              <dd>
                <Badge tone="neutral">{data.scope}</Badge>
              </dd>
              <dt>Status</dt>
              <dd>
                <Badge tone={data.enabled ? "success" : "neutral"}>
                  {data.enabled ? "enabled" : "paused"}
                </Badge>
              </dd>
            </dl>
          )}
        </QueryView>

        <TopBar>
          <TopBarTitle subtitle="Every time this routine fired">
            Run history
          </TopBarTitle>
        </TopBar>
        <QueryView query={runs} label="this routine's run history">
          {(items) =>
            items.length === 0 ? (
              <EmptyState
                icon={<Clock />}
                title="No runs yet"
                description="This routine has not fired yet — manually or on a schedule."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Triggered by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>When</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((run) => {
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
                        <TableCell>
                          {formatRelativeTime(run.createdAt, now)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )
          }
        </QueryView>
      </PageShell>
    </>
  );
}

/**
 * The union of every routine's own run ids, across the run histories
 * already fetched for "last result" — the correlation that keeps the
 * live-runs section to routine-launched runs only, never a channel
 * host's or another system run leaking in from the same cross-tenant
 * `/api/me/workflows/runs` listing `runs-page.tsx` reads.
 */
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
  // BenchProvider owns the active tenant. Never re-fetch principals and take
  // memberships[0] — that ignores the shell's bench switcher.
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

  // Client-side selector over the already-loaded list — not a server fetch.
  // A separate useQuery would race the list load and stick on "not found".
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

  if (openRoutineId !== null) {
    return (
      <RoutineDetailPage
        routine={detailRoutine}
        runs={detailRuns}
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
      onOpen={(id) =>
        navigate(`${ROUTINES_PATH_PREFIX}/${encodeURIComponent(id)}`)
      }
      onCreate={async (input) => {
        if (tenantId === null)
          throw new Error("No bench to create this in yet");
        await createRoutine(tenantId, input);
        invalidateRoutines();
      }}
      onToggleEnabled={(routine, enabled) => {
        if (tenantId === null) return;
        void updateRoutine(tenantId, routine.id, { enabled }).then(
          invalidateRoutines,
        );
      }}
      onRunNow={async (routine) => {
        if (tenantId === null) throw new Error("No bench to run this in yet");
        await runRoutineNow(tenantId, routine.id);
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.routineRuns(tenantId, routine.id),
        });
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.routineRunHistories(tenantId),
        });
      }}
    />
  );
}
