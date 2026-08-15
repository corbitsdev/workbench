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
import type { Channel, DialogStepperStep } from "@corbits/chat-ui";
import {
  DialogStepper,
  listChannels,
  listTenantInvitableDefinitions,
} from "@corbits/chat-ui";
import {
  connectorStatus,
  CopyButton,
  listCredentials,
  listProviders,
  WebhookSecretPanel,
} from "@corbits/settings-ui";
import type { Credential, Provider } from "@corbits/settings-ui";
import { CONNECTOR_REGISTRY } from "@workbench/connections/registry";
import type { WorkflowTriggerField } from "@corbits/workflow-catalog";
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
import { consumePendingNewRoutine } from "../command-palette-actions";
import { consumePendingRoutinePrefill } from "../routine-prefill";
import type { RoutinePrefill } from "../routine-prefill";
import { tenantKeys } from "../query-client";
import { cadenceLabel } from "../routine-trigger";
import { StageCrumbs, StageTopBar } from "../shell/stage-top-bar";
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
  UpdateRoutineInput,
  WorkflowDefinitionSummary,
} from "../routines-api";
import {
  createWebhookTrigger,
  DEFAULT_WEBHOOK_INPUT_TEMPLATE,
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
function WebhookTriggerPanel({
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

type TriggerKind =
  "manual" | "interval" | "daily" | "weekly" | "cron" | "webhook";

function TriggerPicker({
  value,
  onChange,
}: {
  readonly value: RoutineTrigger;
  readonly onChange: (next: RoutineTrigger) => void;
}) {
  const kind: TriggerKind = value === null ? "manual" : value.kind;

  const setKind = (next: Exclude<TriggerKind, "webhook">) => {
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

  // A webhook-bound routine has no cadence to edit here — the binding
  // (hook URL, secret, rotate) lives on the routine's detail page, not
  // this picker. Recreating the routine is the only way to leave webhook
  // mode, the same way catalog vs. describe-to-agent is a create-time,
  // not edit-time, choice.
  if (kind === "webhook") {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">Cadence</span>
        <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
          On webhook — manage the hook URL and secret from this routine's detail
          page.
        </p>
      </div>
    );
  }

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
        No delivery channel on this workbench yet — create a channel first.
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

/**
 * An `"agent"`-kind trigger field (see `@corbits/workflow-catalog`'s
 * `WorkflowTriggerField.kind`) renders as a picker of taskable agent
 * definitions, never a raw-id text box — the same listing the task
 * composer's own agent picker reads (`listTenantInvitableDefinitions`),
 * so "the agent this recurring task runs" is chosen the identical way
 * "New task" chooses one.
 */
function AgentTriggerFieldPicker({
  agents,
  value,
  onChange,
  disabled,
}: {
  readonly agents: readonly { readonly id: string; readonly name: string }[];
  readonly value: string;
  readonly onChange: (id: string) => void;
  readonly disabled?: boolean;
}) {
  const selected = agents.find((a) => a.id === value);
  if (agents.length === 0) {
    return (
      <p className="text-xs text-[var(--ui-fg-muted)]" role="status">
        No taskable agents on this workbench yet — create one first.
      </p>
    );
  }
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          {selected?.name ?? "Choose agent"}
        </Button>
      </MenuTrigger>
      <MenuContent>
        {agents.map((agent) => (
          <MenuItem key={agent.id} onSelect={() => onChange(agent.id)}>
            {agent.name}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

type CreatePath = "catalog" | "describe";
type CreateStep = 1 | 2 | 3;

/**
 * Whether every required triggerFields entry has a non-blank value —
 * gates advancing past Configure the same way an empty delivery channel
 * already does.
 */
export function triggerFieldsSatisfied(
  fields: readonly WorkflowTriggerField[],
  values: Readonly<Record<string, string>>,
): boolean {
  return fields.every(
    (field) => !field.required || (values[field.key] ?? "").trim() !== "",
  );
}

/**
 * Builds the `input` record a catalog routine fires with, from a
 * workflow's declared triggerFields and whatever a person typed into the
 * Configure step. A field left blank is omitted entirely (falling back to
 * its `default` when one is declared) rather than sent as an empty
 * string — the same "blank counts as absent" contract
 * `workflows/pain-point-collateral/src/intake-tool.ts`'s `resolveIntake`
 * already applies on the receiving end.
 */
export function triggerFieldsInput(
  fields: readonly WorkflowTriggerField[],
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  const input: Record<string, string> = {};
  for (const field of fields) {
    const typed = (values[field.key] ?? "").trim();
    if (typed !== "") {
      input[field.key] = typed;
    } else if (field.default !== undefined) {
      input[field.key] = field.default;
    }
  }
  return input;
}

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

/** The routine's summary sentence at the confirm step — one calm line, no
 * raw identifiers, matching `routineDetailSentence`'s tone for a routine
 * that does not exist yet. */
export function catalogConfirmSentence(
  runMode: "once" | "schedule" | "webhook",
  trigger: RoutineTrigger,
  channelTitle: string | null,
): string {
  const when =
    runMode === "once"
      ? "Runs once, right after you create it"
      : runMode === "webhook"
        ? "Fires on webhook delivery"
        : cadenceLabel(trigger);
  if (channelTitle === null) return `${when}.`;
  return `${when}, delivers to ${channelTitle}.`;
}

/** Pulls the tenant's real credentials + providers once the dialog opens,
 * so catalog cards show actual connection state — never a fabricated
 * guess. Mirrors `ConnectionsSection`'s own fetch-on-mount pattern. */
function useDialogConnections(tenantId: string | null, open: boolean) {
  const [connections, setConnections] = useState<{
    readonly credentials: readonly Credential[];
    readonly providers: readonly Provider[];
  } | null>(null);

  useEffect(() => {
    if (!open || tenantId === null) return;
    let cancelled = false;
    Promise.all([listCredentials(tenantId), listProviders(tenantId)])
      .then(([credentials, providers]) => {
        if (!cancelled) setConnections({ credentials, providers });
      })
      .catch(() => {
        if (!cancelled) setConnections({ credentials: [], providers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, open]);

  return connections;
}

/** Taskable agent definitions for an `"agent"`-kind trigger field's
 * picker — reuses the exact listing the task composer's own agent
 * picker fetches (`listTenantInvitableDefinitions`). Mirrors
 * `useDialogConnections` above: only fetches once the dialog is open,
 * a plain effect rather than `useQuery` so this dialog never requires
 * a `QueryClientProvider` ancestor. */
function useTaskableAgents(
  tenantId: string | null,
  open: boolean,
): readonly { readonly id: string; readonly name: string }[] {
  const [agents, setAgents] = useState<
    readonly { readonly id: string; readonly name: string }[]
  >([]);

  useEffect(() => {
    if (!open || tenantId === null) return;
    let cancelled = false;
    listTenantInvitableDefinitions(tenantId)
      .then((definitions) => {
        if (!cancelled) setAgents(definitions);
      })
      .catch(() => {
        if (!cancelled) setAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, open]);

  return agents;
}

export function connectorBadgeLabel(connectorId: string): string {
  const entry = CONNECTOR_REGISTRY[connectorId];
  if (entry === undefined) {
    // A catalog entry's requiredConnections should only ever name real
    // connector ids — this means the catalog and the registry have
    // drifted apart. Render the raw id so the card still shows
    // something, but flag it loudly regardless of build mode: this is a
    // console-only log, not user-visible, so there's no cost to keeping
    // it always on and every cost to a silent fallback hiding drift in
    // production until someone notices a wrong-looking badge.
    console.error(
      `connectorBadgeLabel: "${connectorId}" is not in CONNECTOR_REGISTRY — ` +
        "a workflow-catalog entry's requiredConnections id is out of sync " +
        "with the connections registry.",
    );
    return connectorId;
  }
  return entry.displayName;
}

/**
 * The automatable-workflow card grid: shared by the Source step's
 * catalog picker and the describe path's review-step fallback (a draft
 * with no `definitionId` — Myra didn't pin one, a valid honest outcome
 * — must still let the person pick a workflow rather than dead-end at
 * a permanently-disabled Approve). One rendering, two call sites, so
 * the two pickers can never drift apart.
 */
function WorkflowPickerCards({
  definitions,
  connections,
  selectedId,
  disabled,
  onSelect,
}: {
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly connections: {
    readonly credentials: readonly Credential[];
    readonly providers: readonly Provider[];
  } | null;
  readonly selectedId: string;
  readonly disabled: boolean;
  readonly onSelect: (definitionId: string) => void;
}) {
  return (
    <>
      {definitions.map((definition) => (
        <button
          key={definition.id}
          type="button"
          disabled={disabled}
          aria-pressed={selectedId === definition.id}
          onClick={() => onSelect(definition.id)}
          className={[
            "flex flex-col gap-1 rounded-[var(--ui-radius-md)] border p-2.5 text-left text-xs",
            selectedId === definition.id
              ? "border-[var(--ui-accent)] bg-[var(--ui-accent-soft)]"
              : "border-[var(--ui-border)]",
          ].join(" ")}
        >
          <span className="font-medium text-[var(--ui-fg)]">
            {definition.name}
          </span>
          {definition.whatItDoes !== "" ? (
            <span className="text-[var(--ui-fg-muted)]">
              {definition.whatItDoes}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1 text-[var(--ui-fg-muted)]">
            <Clock className="size-3" />
            {definition.typicalDuration}
          </span>
          {definition.requiredConnections.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {definition.requiredConnections.map((connectorId) => {
                const result =
                  connections === null
                    ? { status: "not_connected" as const }
                    : connectorStatus(
                        connectorBadgeLabel(connectorId),
                        connections.credentials,
                        connections.providers,
                      );
                return (
                  <Badge
                    key={connectorId}
                    tone={result.status === "connected" ? "success" : "neutral"}
                  >
                    {connectorBadgeLabel(connectorId)}
                  </Badge>
                );
              })}
            </div>
          ) : null}
          {definition.exampleOutput !== "" ? (
            <span className="line-clamp-2 whitespace-pre-line text-[11px] text-[var(--ui-fg-muted)]">
              {definition.exampleOutput}
            </span>
          ) : null}
        </button>
      ))}
    </>
  );
}

function CreateRoutineDialog({
  tenantId,
  definitions,
  channels,
  onCreate,
  onCreateWebhookBinding,
  onDescribe,
  onApproveDraft,
  onDiscardDraft,
  open: openProp,
  onOpenChange,
  initialDefinitionId = null,
  initialName = null,
  initialInput = null,
}: {
  readonly tenantId?: string | null;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly channels: readonly Channel[];
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
  readonly onCreateWebhookBinding: (input: {
    name: string;
    definitionId: string;
  }) => Promise<{ id: string; secret: string }>;
  readonly onDescribe: (input: CreateDraftInput) => Promise<RoutineDraft>;
  /** `definitionId` is passed only when the draft itself has none
   * (Myra didn't pin a workflow) and the review step's own fallback
   * picker collected one — see the "no dead end" fallback below. */
  readonly onApproveDraft: (
    draftId: string,
    definitionId?: string,
  ) => Promise<void>;
  readonly onDiscardDraft: (draftId: string) => Promise<void>;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** "Make this a routine" seam (see inbox-page.tsx): opens the dialog
   * already on the given catalog pick and name, its stored input carrying
   * the source task's prompt. The person still picks cadence and confirms
   * — nothing here creates a routine on its own. */
  readonly initialDefinitionId?: string | null;
  readonly initialName?: string | null;
  readonly initialInput?: Record<string, unknown> | null;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const connections = useDialogConnections(tenantId ?? null, open);
  // Only matters for a workflow that declares an `"agent"`-kind trigger
  // field (today, only the recurring-task bridge).
  const taskableAgents = useTaskableAgents(tenantId ?? null, open);
  const [step, setStep] = useState<CreateStep>(1);
  const [path, setPath] = useState<CreatePath>("catalog");
  const [name, setName] = useState("");
  const [definitionId, setDefinitionId] = useState("");
  const [runMode, setRunMode] = useState<"once" | "schedule" | "webhook">(
    "once",
  );
  const [trigger, setTrigger] = useState<RoutineTrigger>(null);
  const [triggerFieldValues, setTriggerFieldValues] = useState<
    Record<string, string>
  >({});
  const [prompt, setPrompt] = useState("");
  const [deliveryChannelId, setDeliveryChannelId] = useState(
    channels[0]?.id ?? "",
  );
  const [pendingDraft, setPendingDraft] = useState<RoutineDraft | null>(null);
  // The review step's own fallback pick when the draft has no
  // `definitionId` — Myra didn't pin a workflow, a valid honest
  // outcome, not an error. Distinct from `definitionId` (the catalog
  // path's own state) so the two pickers never share, and clashing,
  // state.
  const [draftDefinitionPick, setDraftDefinitionPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [webhookRevealed, setWebhookRevealed] = useState<{
    url: string;
    secret: string;
  } | null>(null);

  useEffect(() => {
    if (deliveryChannelId === "" && channels[0] !== undefined) {
      setDeliveryChannelId(channels[0].id);
    }
  }, [channels, deliveryChannelId]);

  // "Make this a routine" seeds the catalog pick and name once, the
  // instant the dialog opens with a prefill — after that the person edits
  // freely, same as any other field in this stepper.
  useEffect(() => {
    if (!open) return;
    if (initialDefinitionId !== null) {
      setPath("catalog");
      setDefinitionId(initialDefinitionId);
    }
    if (initialName !== null) setName(initialName);
    if (initialInput !== null) {
      // Seeds the Configure step's own trigger-field inputs (visibly
      // pre-filled, and counted toward `triggerFieldsSatisfied` so a
      // fully-specified prefill can advance without retyping) — only
      // string values, matching what a trigger field can hold; a
      // non-string entry still reaches the created routine's `input`
      // via createCatalogRoutine's own merge below.
      const stringFields = Object.fromEntries(
        Object.entries(initialInput).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      );
      setTriggerFieldValues((prev) => ({ ...prev, ...stringFields }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selectedDefinition =
    definitions.find((d) => d.id === definitionId) ?? null;
  // A workflow whose result never posts to a channel (e.g. the
  // recurring-task bridge — always delivers to its creator's Inbox)
  // must never be forced through the channel step at all: no picker,
  // no requirement, nothing collected to silently discard. Unresolved
  // (no pick yet, or the "describe" path, which only learns its
  // definitionId after drafting) defaults to requiring one — the
  // honest, prior behavior.
  const deliversToChannel =
    path !== "catalog" ||
    selectedDefinition === null ||
    selectedDefinition.deliveryMode !== "inbox";

  const reset = () => {
    setStep(1);
    setPath("catalog");
    setName("");
    setDefinitionId("");
    setRunMode("once");
    setTrigger(null);
    setTriggerFieldValues({});
    setPrompt("");
    setDeliveryChannelId(channels[0]?.id ?? "");
    setPendingDraft(null);
    setDraftDefinitionPick("");
    setError(null);
    setWebhookRevealed(null);
  };

  const closeDialog = () => {
    setOpen(false);
    reset();
  };

  const discardPendingDraft = () => {
    const draft = pendingDraft;
    if (draft === null) return;
    setPendingDraft(null);
    setDraftDefinitionPick("");
    void onDiscardDraft(draft.id).catch(() => {
      // Discard best-effort; the draft simply stays orphaned server-side.
    });
  };

  const handleCancel = () => {
    discardPendingDraft();
    closeDialog();
  };

  const goBack = () => {
    setError(null);
    if (step === 3) {
      setStep(2);
      return;
    }
    if (path === "describe") discardPendingDraft();
    setStep(1);
  };

  // A non-empty definitionId that doesn't resolve in `definitions` is a
  // dead end further down the stepper (no selectedDefinition to launch
  // against — see the inline message above), so it must not be treated
  // as an honest "picked" state here.
  const canAdvanceFromSource =
    path === "catalog" ? selectedDefinition !== null : prompt.trim().length > 0;

  const draftAndAdvance = () => {
    if (deliveryChannelId === "" || prompt.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void onDescribe({
      prompt: prompt.trim(),
      deliveryChannelId,
      scope: "bench",
    })
      .then((draft) => setPendingDraft(draft))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const createCatalogRoutine = () => {
    if (
      selectedDefinition === null ||
      (deliversToChannel && deliveryChannelId === "")
    )
      return;
    setBusy(true);
    setError(null);
    const routineName =
      name.trim().length > 0 ? name.trim() : selectedDefinition.name;
    // Threads the same field values a manual "Run once now" collects into
    // the stored routine.input record — the one seam the fire path
    // (packages/routines' POST /routines -> RoutineLauncher.launchRoutineRun)
    // actually reads from a create request. A "Make this a routine" prefill
    // (initialInput — the source task's prompt) merges underneath: the
    // picked workflow's own trigger fields, if any, take precedence over
    // it rather than the reverse.
    const triggerFieldInput =
      selectedDefinition.triggerFields.length > 0
        ? triggerFieldsInput(
            selectedDefinition.triggerFields,
            triggerFieldValues,
          )
        : undefined;
    const triggerInput =
      initialInput !== null || triggerFieldInput !== undefined
        ? { ...(initialInput ?? {}), ...triggerFieldInput }
        : undefined;

    if (runMode === "webhook") {
      void onCreateWebhookBinding({ name: routineName, definitionId })
        .then((binding) =>
          onCreate({
            name: routineName,
            definitionId,
            scope: "bench",
            ...(deliversToChannel ? { deliveryChannelId } : {}),
            trigger: { kind: "webhook", webhookTriggerId: binding.id },
            runOnceNow: false,
            ...(triggerInput !== undefined ? { input: triggerInput } : {}),
          }).then(() => {
            // Stay open: the secret is shown exactly once, right now —
            // closing immediately (the non-webhook path's behavior)
            // would lose it before the operator can copy it.
            setWebhookRevealed({
              url: webhookTriggerUrl(binding.id),
              secret: binding.secret,
            });
          }),
        )
        .catch((cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setBusy(false));
      return;
    }

    void onCreate({
      name: routineName,
      definitionId,
      scope: "bench",
      ...(deliversToChannel ? { deliveryChannelId } : {}),
      trigger: runMode === "once" ? null : trigger,
      runOnceNow: runMode === "once",
      ...(triggerInput !== undefined ? { input: triggerInput } : {}),
    })
      .then(() => closeDialog())
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const approveDraft = () => {
    if (pendingDraft === null) return;
    const definitionOverride =
      pendingDraft.definitionId === null && draftDefinitionPick !== ""
        ? draftDefinitionPick
        : undefined;
    setBusy(true);
    setError(null);
    void onApproveDraft(pendingDraft.id, definitionOverride)
      .then(() => closeDialog())
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  const stepperSteps: readonly DialogStepperStep[] = [
    {
      label: "Source",
      guidance: "Pick a known workflow, or describe what you want automated.",
    },
    {
      label: "Configure",
      guidance:
        path === "catalog"
          ? "Choose when it runs and where results land."
          : pendingDraft === null
            ? "Choose where results land — an agent drafts the steps next."
            : "Review what the agent proposes before creating it.",
    },
    {
      label: "Confirm",
      guidance:
        path === "catalog"
          ? "Give it a name if you like, then create it."
          : "Check the proposed steps, then approve to create the routine.",
    },
  ];

  const showBack = step > 1;

  let primaryLabel = "Next";
  let primaryDisabled = busy;
  let primaryOnClick = () => setStep(2);

  if (step === 1) {
    primaryDisabled = busy || !canAdvanceFromSource;
    primaryOnClick = () => setStep(2);
  } else if (step === 2 && path === "catalog") {
    primaryLabel = "Next";
    primaryDisabled =
      busy ||
      (deliversToChannel && deliveryChannelId === "") ||
      !triggerFieldsSatisfied(
        selectedDefinition?.triggerFields ?? [],
        triggerFieldValues,
      );
    primaryOnClick = () => setStep(3);
  } else if (step === 2 && path === "describe" && pendingDraft === null) {
    primaryLabel = busy ? "Drafting…" : "Draft with agent";
    primaryDisabled = busy || deliveryChannelId === "";
    primaryOnClick = draftAndAdvance;
  } else if (step === 2 && path === "describe" && pendingDraft !== null) {
    primaryLabel = "Next";
    primaryDisabled = busy;
    primaryOnClick = () => setStep(3);
  } else if (step === 3 && path === "catalog") {
    primaryLabel = busy
      ? "Creating…"
      : runMode === "once"
        ? "Create & run now"
        : "Create routine";
    primaryDisabled =
      busy ||
      selectedDefinition === null ||
      (deliversToChannel && deliveryChannelId === "") ||
      !triggerFieldsSatisfied(
        selectedDefinition?.triggerFields ?? [],
        triggerFieldValues,
      );
    primaryOnClick = createCatalogRoutine;
  } else if (step === 3 && path === "describe") {
    primaryLabel = busy ? "Approving…" : "Approve";
    // A draft with no definitionId (Myra didn't pin a workflow) is a
    // dead end unless the fallback picker below has collected one —
    // Approve stays disabled until it does, never clickable into a
    // guaranteed 400 with no recovery.
    const needsDefinitionPick =
      pendingDraft !== null && pendingDraft.definitionId === null;
    primaryDisabled =
      busy ||
      pendingDraft === null ||
      (needsDefinitionPick && draftDefinitionPick === "");
    primaryOnClick = approveDraft;
  }

  const draft = pendingDraft;
  const draftName =
    draft !== null
      ? draft.proposedName !== null && draft.proposedName !== ""
        ? draft.proposedName
        : draft.prompt.slice(0, 80)
      : null;
  const autonomyLines =
    draft !== null ? autonomyReviewLines(draft.autonomy) : [];
  const channelTitle =
    channels.find((c) => c.id === deliveryChannelId)?.title ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          handleCancel();
          return;
        }
        setOpen(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New routine</DialogTitle>
          <DialogDescription>
            A guided setup — from the catalog for something known, or describe
            it to an agent.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!primaryDisabled) primaryOnClick();
          }}
        >
          <DialogStepper step={step} steps={stepperSteps} />

          {step === 1 ? (
            <>
              <div className="flex flex-col gap-1.5">
                <span id="routine-source-label" className="text-xs font-medium">
                  Workflow
                </span>
                <div
                  role="group"
                  aria-labelledby="routine-source-label"
                  className="grid grid-cols-2 gap-2"
                >
                  <WorkflowPickerCards
                    definitions={definitions}
                    connections={connections}
                    selectedId={path === "catalog" ? definitionId : ""}
                    disabled={busy}
                    onSelect={(id) => {
                      setPath("catalog");
                      setDefinitionId(id);
                      setTriggerFieldValues({});
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    aria-pressed={path === "describe"}
                    onClick={() => setPath("describe")}
                    className={[
                      "flex flex-col gap-0.5 rounded-[var(--ui-radius-md)] border p-2.5 text-left text-xs",
                      path === "describe"
                        ? "border-[var(--ui-accent)] bg-[var(--ui-accent-soft)]"
                        : "border-[var(--ui-border)]",
                    ].join(" ")}
                  >
                    <span className="font-medium text-[var(--ui-fg)]">
                      Describe it to an agent
                    </span>
                    <span className="text-[var(--ui-fg-muted)]">
                      An agent drafts the steps for you to review.
                    </span>
                  </button>
                </div>
                {definitions.length === 0 ? (
                  <p
                    className="text-xs text-[var(--ui-fg-muted)]"
                    role="status"
                  >
                    No automatable workflows on this workbench yet — describe it
                    instead.
                  </p>
                ) : null}
                {path === "catalog" &&
                definitionId !== "" &&
                selectedDefinition === null ? (
                  <p className="text-xs text-destructive" role="alert">
                    This workflow isn't in your automatable catalog, so it can't
                    be scheduled — pick one of the cards above, or describe it
                    instead.
                  </p>
                ) : null}
              </div>

              {path === "describe" ? (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor="routine-prompt"
                    className="text-xs font-medium"
                  >
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
                </div>
              ) : null}
            </>
          ) : null}

          {step === 2 && path === "catalog" ? (
            <>
              {selectedDefinition !== null &&
              selectedDefinition.exampleOutput !== "" ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">Example output</span>
                  <span className="whitespace-pre-line rounded-[var(--ui-radius-md)] border border-[var(--ui-border)] bg-[var(--ui-bg-subtle)] p-2 text-xs text-[var(--ui-fg-muted)]">
                    {selectedDefinition.exampleOutput}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium">When</span>
                <div className="flex gap-1">
                  {(
                    [
                      ["once", "Run once now"],
                      ["schedule", "On a schedule"],
                      ["webhook", "On webhook"],
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
                {runMode === "webhook" ? (
                  <p
                    className="text-xs text-[var(--ui-fg-muted)]"
                    role="status"
                  >
                    A hook URL and signing secret are generated when you create
                    this routine — shown once, on the next step.
                  </p>
                ) : null}
              </div>
              {selectedDefinition !== null &&
              selectedDefinition.triggerFields.length > 0 ? (
                <div className="flex flex-col gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-[var(--ui-fg-muted)] uppercase">
                    Trigger inputs
                  </h3>
                  {selectedDefinition.triggerFields.map((field) => (
                    <div key={field.key} className="flex flex-col gap-1.5">
                      <label
                        htmlFor={`routine-trigger-field-${field.key}`}
                        className="text-xs font-medium"
                      >
                        {field.label}
                        {field.required ? "" : " (optional)"}
                      </label>
                      {field.kind === "agent" ? (
                        <AgentTriggerFieldPicker
                          agents={taskableAgents}
                          value={triggerFieldValues[field.key] ?? ""}
                          disabled={busy}
                          onChange={(id) =>
                            setTriggerFieldValues((values) => ({
                              ...values,
                              [field.key]: id,
                            }))
                          }
                        />
                      ) : (
                        <Input
                          id={`routine-trigger-field-${field.key}`}
                          value={triggerFieldValues[field.key] ?? ""}
                          placeholder={field.placeholder}
                          disabled={busy}
                          onChange={(event) =>
                            setTriggerFieldValues((values) => ({
                              ...values,
                              [field.key]: event.target.value,
                            }))
                          }
                        />
                      )}
                      {field.help !== undefined ? (
                        <p className="text-xs text-[var(--ui-fg-muted)]">
                          {field.help}
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
              {deliversToChannel ? (
                <div className="flex flex-col gap-1.5">
                  <span
                    id="routine-delivery-label"
                    className="text-xs font-medium"
                  >
                    Deliver results to
                  </span>
                  <DeliveryChannelPicker
                    channels={channels}
                    value={deliveryChannelId}
                    onChange={setDeliveryChannelId}
                    disabled={busy}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium">
                    Deliver results to
                  </span>
                  <p
                    className="text-xs text-[var(--ui-fg-muted)]"
                    role="status"
                  >
                    Results land in your Inbox — this workflow never posts to a
                    channel.
                  </p>
                </div>
              )}
            </>
          ) : null}

          {step === 2 && path === "describe" && pendingDraft === null ? (
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
          ) : null}

          {step === 2 && path === "describe" && draft !== null ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                  Proposed steps
                </span>
                {draft.proposedSteps.length === 0 ? (
                  <p
                    className="text-sm text-[var(--ui-fg-muted)]"
                    role="status"
                  >
                    No steps proposed yet.
                  </p>
                ) : (
                  <ol className="list-decimal space-y-1.5 pl-5 text-sm">
                    {draft.proposedSteps.map((draftStep, index) => (
                      <li key={`${draftStep.title}-${String(index)}`}>
                        <span className="font-medium">{draftStep.title}</span>
                        {draftStep.detail !== undefined ? (
                          <span className="text-[var(--ui-fg-muted)]">
                            {" — "}
                            {draftStep.detail}
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
                  <p className="text-sm">
                    {cadenceLabel(draft.proposedTrigger)}
                  </p>
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
            </div>
          ) : null}

          {step === 3 && path === "catalog" ? (
            webhookRevealed !== null ? (
              <WebhookSecretPanel
                url={webhookRevealed.url}
                secret={webhookRevealed.secret}
                samplePayload={sampleWebhookPayload()}
              />
            ) : (
              <>
                <p className="text-sm text-[var(--ui-fg)]">
                  {catalogConfirmSentence(runMode, trigger, channelTitle)}
                </p>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="routine-name" className="text-xs font-medium">
                    Name (optional)
                  </label>
                  <Input
                    id="routine-name"
                    value={name}
                    placeholder={selectedDefinition?.name ?? "Morning brief"}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              </>
            )
          ) : null}

          {step === 3 && path === "describe" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-[var(--ui-fg-muted)]">
                  Name
                </span>
                <p className="text-sm font-medium text-[var(--ui-fg)]">
                  {draftName}
                </p>
              </div>
              <p className="text-xs text-[var(--ui-fg-muted)]">
                From: {draft?.prompt}
              </p>
              {draft !== null && draft.definitionId === null ? (
                <div className="flex flex-col gap-1.5">
                  <span
                    id="draft-workflow-pick-label"
                    className="text-xs font-medium"
                  >
                    Workflow
                  </span>
                  <p className="text-xs text-[var(--ui-fg-muted)]">
                    Myra didn't pin a workflow — pick one.
                  </p>
                  <div
                    role="group"
                    aria-labelledby="draft-workflow-pick-label"
                    className="grid grid-cols-2 gap-2"
                  >
                    <WorkflowPickerCards
                      definitions={definitions}
                      connections={connections}
                      selectedId={draftDefinitionPick}
                      disabled={busy}
                      onSelect={setDraftDefinitionPick}
                    />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {error !== null ? (
            <p className="text-xs text-[var(--ui-danger)]" role="alert">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            {webhookRevealed !== null ? (
              <Button type="button" size="sm" onClick={closeDialog}>
                Done
              </Button>
            ) : (
              <>
                {showBack ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={goBack}
                  >
                    Back
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={handleCancel}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={primaryDisabled}>
                  {primaryLabel}
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Minimal edit surface: name and cadence only, over the existing `PATCH
 * /routines/:id` route (`updateRoutine`). Delivery channel and workflow
 * are set at create time and stay out of scope here.
 */
function EditRoutineDialog({
  routine,
  onSave,
  open,
  onOpenChange,
}: {
  readonly routine: Routine;
  readonly onSave: (patch: UpdateRoutineInput) => Promise<void>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(routine.name);
  const [trigger, setTrigger] = useState<RoutineTrigger>(routine.trigger);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(routine.name);
    setTrigger(routine.trigger);
    setError(null);
  }, [open, routine.name, routine.trigger]);

  const complete = name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit routine</DialogTitle>
          <DialogDescription>Name and cadence only.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!complete) return;
            setBusy(true);
            setError(null);
            void onSave({ name: name.trim(), trigger })
              .then(() => onOpenChange(false))
              .catch((cause: unknown) => {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              })
              .finally(() => setBusy(false));
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="routine-edit-name" className="text-xs font-medium">
              Name
            </label>
            <Input
              id="routine-edit-name"
              value={name}
              required
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <TriggerPicker value={trigger} onChange={setTrigger} />

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
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Recent-run rows deep-link to the channel the routine delivers to — a
 * routine has one `deliveryChannelId`, not a per-run one, so every row in
 * a given table shares the same destination. Rows render as plain data
 * when there is nowhere to deep-link (`deliveryChannelId` absent or no
 * `onOpenChannel` handler wired).
 */
function RunsTable({
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
  tenantId = null,
  routines,
  runHistories,
  liveRuns: _liveRuns,
  now = Date.now(),
  definitions,
  channels,
  selectedId,
  onSelect: _onSelect,
  onCreate,
  onCreateWebhookBinding,
  webhookTrigger,
  onRotateWebhookSecret,

  onDescribe,
  onApproveDraft,
  onDiscardDraft,
  onToggleEnabled,
  onRunNow,
  onEdit,
  onOpenRuns,
  onOpenChannel,
}: {
  readonly tenantId?: string | null;
  readonly routines: APIQuery<readonly Routine[]>;
  readonly runHistories: ReadonlyMap<string, readonly RoutineRun[]>;
  readonly liveRuns: APIQuery<readonly WorkflowRun[]>;
  readonly now?: number;
  readonly definitions: readonly WorkflowDefinitionSummary[];
  readonly channels: readonly Channel[];
  readonly selectedId: string | null;
  readonly onSelect: (routineId: string | null) => void;
  readonly onCreate: (input: CreateRoutineInput) => Promise<void>;
  readonly onCreateWebhookBinding: (input: {
    name: string;
    definitionId: string;
  }) => Promise<{ id: string; secret: string }>;
  readonly webhookTrigger: APIQuery<WebhookTrigger> | null;
  readonly onRotateWebhookSecret: () => Promise<{ secret: string }>;
  readonly onDescribe: (input: CreateDraftInput) => Promise<RoutineDraft>;
  readonly onApproveDraft: (
    draftId: string,
    definitionId?: string,
  ) => Promise<void>;
  readonly onDiscardDraft: (draftId: string) => Promise<void>;
  readonly onToggleEnabled: (routine: Routine, enabled: boolean) => void;
  readonly onRunNow: (routine: Routine) => Promise<void>;
  readonly onEdit: (
    routine: Routine,
    patch: UpdateRoutineInput,
  ) => Promise<void>;
  readonly onOpenRuns: () => void;
  readonly onOpenChannel: (channelId: string) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<RoutinePrefill | null>(
    null,
  );

  useEffect(() => {
    const onCreateEvent = () => {
      setCreatePrefill(consumePendingRoutinePrefill());
      setCreateOpen(true);
    };
    window.addEventListener("workbench:routines:create", onCreateEvent);
    return () =>
      window.removeEventListener("workbench:routines:create", onCreateEvent);
  }, []);

  // The command palette (or "Make this a routine" — see inbox-page.tsx)
  // may have requested "New routine" from another page, before this
  // listener existed to catch the dispatch — see pending-dialog-request.ts.
  // Consume that flag, and any prefill stashed alongside it, now that
  // we've mounted.
  useEffect(() => {
    if (consumePendingNewRoutine()) {
      setCreatePrefill(consumePendingRoutinePrefill());
      setCreateOpen(true);
    }
  }, []);

  useEffect(() => {
    setEditOpen(false);
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
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus /> New routine
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateOpen(true)}
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
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
            </>
          )
        }
      />
      {selected !== null && routinePausedMessage(selected) !== null ? (
        <div
          className="mx-4 mt-3 flex flex-col gap-1 rounded-[var(--ui-radius-md)] border border-destructive/40 bg-destructive/10 p-3 text-sm"
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
      <CreateRoutineDialog
        tenantId={tenantId}
        definitions={definitions}
        channels={channels}
        onCreate={onCreate}
        onCreateWebhookBinding={onCreateWebhookBinding}
        onDescribe={onDescribe}
        onApproveDraft={onApproveDraft}
        onDiscardDraft={onDiscardDraft}
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next);
          // A cancelled or completed prefilled session must not haunt the
          // next blank "New routine" open.
          if (!next) setCreatePrefill(null);
        }}
        initialDefinitionId={createPrefill?.definitionId ?? null}
        initialName={createPrefill?.name ?? null}
        initialInput={createPrefill?.input ?? null}
      />
      {selected !== null ? (
        <EditRoutineDialog
          routine={selected}
          onSave={(patch) => onEdit(selected, patch)}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      ) : null}

      {/* List lives in shell col2; stage is detail only. */}
      <div className="flex min-h-0 flex-1 flex-col">
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
  webhookTrigger = null,
  onRotateWebhookSecret,
  onOpenRuns,
  onOpenChannel,
  onEdit,
}: {
  readonly routine: APIQuery<Routine>;
  readonly runs: APIQuery<readonly RoutineRun[]>;
  readonly onBack: () => void;
  readonly now?: number;
  readonly definitions?: readonly WorkflowDefinitionSummary[];
  readonly webhookTrigger?: APIQuery<WebhookTrigger> | null;
  readonly onRotateWebhookSecret?: () => Promise<{ secret: string }>;
  readonly onOpenRuns: () => void;
  readonly onOpenChannel: (channelId: string) => void;
  readonly onEdit: (
    routine: Routine,
    patch: UpdateRoutineInput,
  ) => Promise<void>;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const deliveryChannelId =
    routine.kind === "ready" ? routine.data.deliveryChannelId : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      {routine.kind === "ready" ? (
        <EditRoutineDialog
          routine={routine.data}
          onSave={(patch) => onEdit(routine.data, patch)}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      ) : null}
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
              onClick={() => setEditOpen(true)}
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

  const onCreateWebhookBinding = async (input: {
    name: string;
    definitionId: string;
  }) => {
    if (tenantId === null)
      throw new Error("No workbench to create this in yet");
    const created = await createWebhookTrigger(tenantId, {
      name: input.name,
      workflowDefinitionId: input.definitionId,
      inputTemplate: DEFAULT_WEBHOOK_INPUT_TEMPLATE,
    });
    return { id: created.id, secret: created.secret };
  };

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
        webhookTrigger={
          selectedWebhookTriggerId !== null ? webhookTriggerQuery : null
        }
        onRotateWebhookSecret={onRotateWebhookSecret}
        onBack={() => navigate(ROUTINES_PATH_PREFIX)}
        onOpenRuns={() => navigate("/insights/runs")}
        onOpenChannel={(channelId) => navigate(channelPath(channelId))}
        onEdit={async (routine, patch) => {
          if (tenantId === null)
            throw new Error("No workbench to edit this in yet");
          await updateRoutine(tenantId, routine.id, patch);
          invalidateRoutines();
        }}
      />
    );
  }

  return (
    <RoutinesListPage
      tenantId={tenantId}
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
          throw new Error("No workbench to create this in yet");
        await createRoutine(tenantId, input);
        invalidateRoutines();
        toast(routineCreatedToast(input.name));
      }}
      onCreateWebhookBinding={onCreateWebhookBinding}
      webhookTrigger={
        selectedWebhookTriggerId !== null ? webhookTriggerQuery : null
      }
      onRotateWebhookSecret={onRotateWebhookSecret}
      onDescribe={async (input) => {
        if (tenantId === null)
          throw new Error("No workbench to draft this in yet");
        return createRoutineDraft(tenantId, input);
      }}
      onApproveDraft={async (draftId, definitionId) => {
        if (tenantId === null)
          throw new Error("No workbench to approve this draft in yet");
        const result = await approveRoutineDraft(
          tenantId,
          draftId,
          definitionId,
        );
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
        if (tenantId === null)
          throw new Error("No workbench to run this on yet");
        await runRoutineNow(tenantId, routine.id);
        invalidateRoutines();
        toast(routineRunStartedToast(routine.name));
      }}
      onEdit={async (routine, patch) => {
        if (tenantId === null)
          throw new Error("No workbench to edit this in yet");
        await updateRoutine(tenantId, routine.id, patch);
        invalidateRoutines();
      }}
      onOpenRuns={() => navigate("/insights/runs")}
      onOpenChannel={(channelId) => navigate(channelPath(channelId))}
    />
  );
}
