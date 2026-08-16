// Routines: named automations over workflow runs.
// Layout matches the shell mock — col2 search + simple list (name, when,
// ON/OFF); detail is calm (steps, three recent runs, All runs & traces).
// Creating and editing a routine happens in the canvas column's routine
// panel now (CL-6125, see shell/routine-panel.tsx) — this page only lists
// and links to it via `useOpenRoutineInCanvas`.
import {
  Badge,
  Button,
  EmptyState,
  formatRelativeTime,
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
import { CopyButton, WebhookSecretPanel } from "@corbits/settings-ui";
import { Clock, Plus, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { APIQuery } from "@corbits/api-query";
import { QueryView } from "@corbits/api-query";

import { useAPIQuery, RunsSchema } from "../api";
import type { WorkflowRun } from "../api";
import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { tenantKeys } from "../query-client";
import { cadenceLabel } from "../routine-trigger";
import { useOpenRoutineInCanvas } from "../shell/canvas-availability";
import { StageCrumbs, StageTopBar } from "../shell/stage-top-bar";
import {
  listRoutineRuns,
  listRoutines,
  listWorkflowDefinitions,
  routineRunStartedToast,
  runRoutineNow,
  updateRoutine,
  useTenantQuery,
} from "../routines-api";
import type {
  Routine,
  RoutineRun,
  WorkflowDefinitionSummary,
} from "../routines-api";
import {
  getWebhookTrigger,
  rotateWebhookTriggerSecret,
  sampleWebhookPayload,
  webhookTriggerUrl,
} from "../webhook-triggers-api";
import type { WebhookTrigger } from "../webhook-triggers-api";

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

/** Plain-language state for a routine the scheduler has stopped firing —
 * `consecutiveFailures` at the moment it dead-lettered equals the
 * threshold, so it's an honest count, not a guess. `null` for a
 * healthy routine (never rendered). */
function routinePausedMessage(routine: Routine): string | null {
  if (routine.deadLetteredAt === null) return null;
  return `Paused after ${routine.consecutiveFailures} failed attempt${
    routine.consecutiveFailures === 1 ? "" : "s"
  }.`;
}

/** The most recent recorded failure's own error text, for the honest
 * "why" next to `routinePausedMessage`'s "that". `undefined` runs
 * (still loading) and runs with no `error` are skipped. */
function mostRecentRunError(runs: readonly RoutineRun[]): string | null {
  const failed = runs.find(
    (run) => run.error !== undefined && run.error !== null,
  );
  return failed?.error ?? null;
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

/**
 * The routine detail view's webhook section: hook URL (built from the
 * trigger id, matching `POST /api/webhooks/:triggerId`), status, and a
 * "Rotate secret" action. Secret text only ever appears here right after
 * a rotate — `GET .../webhook-triggers/:id` never returns it, so between
 * rotates the panel shows the URL and payload sample with the secret row
 * masked, exactly like a freshly-loaded page that has never seen it.
 */
export function WebhookTriggerPanel({
  webhookTrigger,
  onRotate,
}: {
  readonly webhookTrigger: APIQuery<WebhookTrigger>;
  readonly onRotate: () => Promise<{ secret: string }>;
}) {
  const [rotatedSecret, setRotatedSecret] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);

  const triggerId =
    webhookTrigger.kind === "ready" ? webhookTrigger.data.id : null;
  useEffect(() => {
    setRotatedSecret(null);
    setRotateError(null);
  }, [triggerId]);

  return (
    <section aria-label="Webhook trigger">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
          Webhook
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={rotating || triggerId === null}
          onClick={() => {
            setRotating(true);
            setRotateError(null);
            void onRotate()
              .then(({ secret }) => setRotatedSecret(secret))
              .catch((cause: unknown) => {
                setRotateError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => setRotating(false));
          }}
        >
          <RotateCw /> {rotating ? "Rotating…" : "Rotate secret"}
        </Button>
      </div>
      {rotateError !== null ? (
        <p className="mb-2 text-xs text-[var(--ui-danger)]" role="alert">
          {rotateError}
        </p>
      ) : null}
      {webhookTrigger.kind !== "ready" || triggerId === null ? (
        <p className="text-sm text-[var(--ui-fg-muted)]">
          Loading webhook details…
        </p>
      ) : rotatedSecret !== null ? (
        <WebhookSecretPanel
          url={webhookTriggerUrl(triggerId)}
          secret={rotatedSecret}
          samplePayload={sampleWebhookPayload()}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Hook URL</span>
            <div className="flex items-center gap-1.5 rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-2.5 py-1.5">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--ui-fg)]">
                {webhookTriggerUrl(triggerId)}
              </code>
              <CopyButton
                value={webhookTriggerUrl(triggerId)}
                label="Copy hook URL"
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Signing secret</span>
            <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
              Hidden — shown only once, right after creation or a rotate. Rotate
              to issue (and reveal) a new one; the old secret stops verifying
              immediately.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium">Example payload</span>
            <pre className="overflow-x-auto rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] px-2.5 py-2 font-mono text-xs whitespace-pre-wrap text-[var(--ui-fg-muted)]">
              {sampleWebhookPayload()}
            </pre>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Recent-run rows deep-link to the channel the routine delivers to — a
 * routine has one `deliveryChannelId`, not a per-run one, so every row in
 * a given table shares the same destination. Rows render as plain data
 * when there is nowhere to deep-link (`deliveryChannelId` absent or no
 * `onOpenChannel` handler wired).
 */
export function RunsTable({
  runs,
  now,
  emptyTitle,
  emptyDescription,
  deliveryChannelId = null,
  onOpenChannel,
}: {
  readonly runs: readonly RoutineRun[];
  readonly now: number;
  readonly emptyTitle: string;
  readonly emptyDescription: string;
  readonly deliveryChannelId?: string | null;
  readonly onOpenChannel?: (channelId: string) => void;
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
  const channelId =
    deliveryChannelId !== null && onOpenChannel !== undefined
      ? deliveryChannelId
      : null;
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
          const rowProps =
            channelId !== null
              ? {
                  role: "link" as const,
                  tabIndex: 0,
                  className: "routine-run-row-linked",
                  onClick: () => onOpenChannel?.(channelId),
                  onKeyDown: (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onOpenChannel?.(channelId);
                  },
                }
              : {};
          const hasError = run.error !== undefined && run.error !== null;
          return (
            <TableRow key={run.runId} {...rowProps}>
              <TableCell>
                <Badge tone={hasError ? "danger" : "neutral"}>
                  {run.triggeredBy === "schedule-failed"
                    ? "Failed to start"
                    : run.triggeredBy}
                </Badge>
                {hasError ? (
                  <p className="mt-1 max-w-xs text-xs text-[var(--ui-fg-muted)]">
                    {run.error}
                  </p>
                ) : null}
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
  webhookTrigger,
  onRotateWebhookSecret,
  onToggleEnabled,
  onRunNow,
  onOpenRuns,
  onOpenChannel,
}: {
  readonly routines: APIQuery<readonly Routine[]>;
  readonly runHistories: ReadonlyMap<string, readonly RoutineRun[]>;
  readonly liveRuns: APIQuery<readonly WorkflowRun[]>;
  readonly now?: number;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly channels: readonly Channel[];
  readonly selectedId: string | null;
  readonly onSelect: (routineId: string | null) => void;
  readonly webhookTrigger: APIQuery<WebhookTrigger> | null;
  readonly onRotateWebhookSecret: () => Promise<{ secret: string }>;
  readonly onToggleEnabled: (routine: Routine, enabled: boolean) => void;
  readonly onRunNow: (routine: Routine) => Promise<void>;
  readonly onOpenRuns: () => void;
  readonly onOpenChannel: (channelId: string) => void;
}) {
  const openRoutine = useOpenRoutineInCanvas();

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
      <StageTopBar
        title={selected === null ? "Routines" : selected.name}
        subtitle={
          selected === null
            ? routines.kind === "ready"
              ? `${routines.data.length} automations`
              : null
            : routineDetailSentence(selected, channels)
        }
        actions={
          selected === null ? (
            <Button size="sm" onClick={() => openRoutine({ routineId: null })}>
              <Plus /> New routine
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => openRoutine({ routineId: null })}
              >
                New routine
              </Button>
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
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => openRoutine({ routineId: selected.id })}
              >
                Edit
              </Button>
            </>
          )
        }
      />
      {selected !== null && routinePausedMessage(selected) !== null ? (
        <div
          className="stage-content mx-4 mt-3 flex flex-col gap-1 rounded-[var(--ui-radius-md)] border border-destructive/40 bg-destructive/10 p-3 text-sm"
          role="alert"
        >
          <p className="m-0 font-medium text-destructive">
            {routinePausedMessage(selected)}
          </p>
          {mostRecentRunError(recentRuns) !== null ? (
            <p className="m-0 text-xs text-[var(--ui-fg-muted)]">
              {mostRecentRunError(recentRuns)}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* List lives in shell col2; stage is detail only. */}
      <div className="stage-content flex min-h-0 flex-1 flex-col">
        {selected === null ? (
          <div className="flex flex-1 items-center justify-center p-6">
            {routines.kind === "ready" && routines.data.length === 0 ? (
              <RichEmptyState
                icon={<Clock />}
                title="No routines yet"
                description="Create one from a workflow or a prompt."
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
            <section className="border-b border-[var(--ui-border)] px-4 py-3">
              <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                Steps
              </h3>
              {steps.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">
                  Runs workflow{" "}
                  <span className="font-medium text-[var(--ui-fg)]">
                    {definitions.find((d) => d.id === selected.definitionId)
                      ?.name ?? "selected agent"}
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

            {selected.trigger !== null &&
            selected.trigger.kind === "webhook" ? (
              <section className="border-b border-[var(--ui-border)] px-4 py-3">
                <WebhookTriggerPanel
                  webhookTrigger={webhookTrigger ?? { kind: "loading" }}
                  onRotate={onRotateWebhookSecret}
                />
              </section>
            ) : null}

            <section className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                  Recent runs
                </h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onOpenRuns}
                >
                  All runs & traces →
                </Button>
              </div>
              <RunsTable
                runs={recentRuns}
                now={now}
                emptyTitle="No runs yet"
                emptyDescription="This routine has not fired yet — manually or on a schedule."
                deliveryChannelId={selected.deliveryChannelId}
                onOpenChannel={onOpenChannel}
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
  channels = [],
  webhookTrigger = null,
  onRotateWebhookSecret,
  onOpenRuns,
  onOpenChannel,
}: {
  readonly routine: APIQuery<Routine>;
  readonly runs: APIQuery<readonly RoutineRun[]>;
  readonly onBack: () => void;
  readonly now?: number;
  readonly definitions?: readonly WorkflowDefinitionSummary[];
  readonly channels?: readonly Channel[];
  readonly webhookTrigger?: APIQuery<WebhookTrigger> | null;
  readonly onRotateWebhookSecret?: () => Promise<{ secret: string }>;
  readonly onOpenRuns: () => void;
  readonly onOpenChannel: (channelId: string) => void;
}) {
  const openRoutine = useOpenRoutineInCanvas();
  const deliveryChannelId =
    routine.kind === "ready" ? routine.data.deliveryChannelId : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        title={
          <StageCrumbs
            crumbs={[
              { label: "Routines", onSelect: onBack },
              {
                label: routine.kind === "ready" ? routine.data.name : "Routine",
              },
            ]}
          />
        }
        actions={
          routine.kind === "ready" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                openRoutine({
                  routineId: routine.kind === "ready" ? routine.data.id : null,
                })
              }
            >
              Edit
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <QueryView query={routine} label="this routine" skeleton="detail">
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
                  {data.deliveryChannelId !== null ? (
                    <>
                      <dt className="text-[var(--ui-fg-muted)]">Delivers to</dt>
                      <dd>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-auto p-0 font-normal"
                          onClick={() =>
                            onOpenChannel(data.deliveryChannelId as string)
                          }
                        >
                          {channels.find((c) => c.id === data.deliveryChannelId)
                            ?.title ?? "Open workbench"}
                        </Button>
                      </dd>
                    </>
                  ) : null}
                </dl>
                {routinePausedMessage(data) !== null ? (
                  <div
                    className="flex flex-col gap-1 rounded-[var(--ui-radius-md)] border border-destructive/40 bg-destructive/10 p-3 text-sm"
                    role="alert"
                  >
                    <p className="m-0 font-medium text-destructive">
                      {routinePausedMessage(data)}
                    </p>
                    {runs.kind === "ready" &&
                    mostRecentRunError(runs.data) !== null ? (
                      <p className="m-0 text-xs text-[var(--ui-fg-muted)]">
                        {mostRecentRunError(runs.data)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                <section>
                  <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                    Steps
                  </h3>
                  {steps.length === 0 ? (
                    <p className="mt-2 text-sm text-[var(--ui-fg-muted)]">
                      Runs workflow{" "}
                      {definitions.find((d) => d.id === data.definitionId)
                        ?.name ?? "selected agent"}
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
                {data.trigger !== null &&
                data.trigger.kind === "webhook" &&
                onRotateWebhookSecret !== undefined ? (
                  <WebhookTriggerPanel
                    webhookTrigger={webhookTrigger ?? { kind: "loading" }}
                    onRotate={onRotateWebhookSecret}
                  />
                ) : null}
              </div>
            );
          }}
        </QueryView>

        <section className="mt-6" aria-label="Run history">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
              Recent runs
            </h3>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenRuns}
            >
              All runs & traces →
            </Button>
          </div>
          <QueryView
            query={runs}
            label="this routine's run history"
            skeleton="rows"
          >
            {(items) => (
              <RunsTable
                runs={items.slice(0, 3)}
                now={now}
                emptyTitle="No runs yet"
                emptyDescription="This routine has not fired yet — manually or on a schedule."
                deliveryChannelId={deliveryChannelId}
                onOpenChannel={onOpenChannel}
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
      ? tenantKeys.channels("none", "channel")
      : tenantKeys.channels(tenantId, "channel"),
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
      return {
        kind: "error",
        message: "Routine not found",
        retry: invalidateRoutines,
      };
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

  // Fetched once per selected routine, not per render of the webhook panel:
  // `GET .../webhook-triggers/:id` never returns the secret (see
  // webhook-triggers-api.ts), so this only ever supplies the URL/status
  // side of the panel — the secret comes from create/rotate responses,
  // held in the panel's own local state.
  const selectedWebhookTriggerId =
    detailRoutine.kind === "ready" &&
    detailRoutine.data.trigger !== null &&
    detailRoutine.data.trigger.kind === "webhook"
      ? detailRoutine.data.trigger.webhookTriggerId
      : null;
  const webhookTriggerQuery = useTenantQuery<WebhookTrigger>(
    tenantId === null || selectedWebhookTriggerId === null
      ? (["tenant", "none", "webhook-trigger", "none"] as const)
      : ([
          "tenant",
          tenantId,
          "webhook-trigger",
          selectedWebhookTriggerId,
        ] as const),
    tenantId !== null && selectedWebhookTriggerId !== null,
    () => getWebhookTrigger(tenantId ?? "", selectedWebhookTriggerId ?? ""),
  );

  const onRotateWebhookSecret = async () => {
    if (tenantId === null || selectedWebhookTriggerId === null) {
      throw new Error("No webhook trigger to rotate");
    }
    const rotated = await rotateWebhookTriggerSecret(
      tenantId,
      selectedWebhookTriggerId,
    );
    void queryClient.invalidateQueries({
      queryKey: [
        "tenant",
        tenantId,
        "webhook-trigger",
        selectedWebhookTriggerId,
      ],
    });
    return { secret: rotated.secret };
  };

  if (openRoutineId !== null && isNarrow) {
    return (
      <RoutineDetailPage
        routine={detailRoutine}
        runs={detailRuns}
        definitions={definitions}
        channels={channels}
        webhookTrigger={
          selectedWebhookTriggerId !== null ? webhookTriggerQuery : null
        }
        onRotateWebhookSecret={onRotateWebhookSecret}
        onBack={() => navigate(ROUTINES_PATH_PREFIX)}
        onOpenRuns={() => navigate("/insights/runs")}
        onOpenChannel={(channelId) => navigate(channelPath(channelId))}
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
      webhookTrigger={
        selectedWebhookTriggerId !== null ? webhookTriggerQuery : null
      }
      onRotateWebhookSecret={onRotateWebhookSecret}
      onToggleEnabled={(routine, enabled) => {
        if (tenantId === null) return;
        void updateRoutine(tenantId, routine.id, { enabled }).then(
          invalidateRoutines,
        );
      }}
      onRunNow={async (routine) => {
        if (tenantId === null)
          throw new Error("No workbench to run this on yet");
        await runRoutineNow(tenantId, routine.id);
        invalidateRoutines();
        toast(routineRunStartedToast(routine.name));
      }}
      onOpenRuns={() => navigate("/insights/runs")}
      onOpenChannel={(channelId) => navigate(channelPath(channelId))}
    />
  );
}
