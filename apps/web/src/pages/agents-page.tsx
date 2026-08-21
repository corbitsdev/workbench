// Agents: the global roster (CL-6354) — every agent definition this bench
// has, one row per definition (name, description, workbenches currently
// using it), with a detail panel that fetches the definition's model on
// demand (`getAgentCapabilities`, the same route the per-workbench
// Assistant editor reads). Create runs through `CreateAgentPanel`, the
// same `createAgentDefinition` (`@corbits/agent-directory`) call the old
// pre-CL-5990 Agents page used. Editing instructions/capabilities stays
// where CL-6215 put it — the per-workbench Assistant tab
// (`@corbits/chat-ui`'s `AgentsSection`) — this page is roster-only, never
// a second instructions editor.

import {
  Badge,
  BulkActionBar,
  Button,
  PageShell,
  RichEmptyState,
  SelectionCheckbox,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
  useListSelection,
} from "@corbits/react-ui";
import type { BadgeTone, SelectionCheckboxState } from "@corbits/react-ui";
import { Archive, Copy, FolderOpen, Plus, Robot, Trash } from "@corbits/icons";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { describeApiError, QueryView } from "@corbits/api-query";

import {
  getAgentCapabilities,
  listTopLevelRuns,
  useAgentDirectory,
  type AgentCapabilities,
  type AgentDefinition,
  type AgentInstance,
} from "../agents-api";
import {
  purposeAgentDefinitions,
  type AgentDefinitionWithDisplayName,
} from "../agents-directory";
import { useBench } from "../bench-context";
import { isAdditiveSelectClick } from "../activatable-row";
import { Link } from "../navigation";
import { useBenchActivity } from "../shell/bench-activity";
import { AGENTS_PATH_PREFIX, agentIdFromPath } from "../path-ids";
import { tenantKeys } from "../query-client";
import { StageTopBar } from "../shell/stage-top-bar";
import { workbenchSettingsPath } from "../workbench-path";
import { CreateAgentPanel } from "./create-agent-panel";

const DEFINITION_STATUS_TONE: Record<AgentDefinition["status"], BadgeTone> = {
  deployed: "success",
  stopped: "neutral",
};

/** The roster's Status column folds a definition's own deployed/stopped
 * state together with its live instances' statuses — a stopped definition
 * always reads Archived; a deployed one reads Running while any instance
 * is actively running, Blocked while any instance is erroring, otherwise
 * Idle. `instances` is expected to already be a tenant's top-level runs
 * (`listTopLevelRuns`), never the folded per-workbench-host noise. */
export type AgentRosterStatus = "running" | "idle" | "blocked" | "archived";

const AGENT_ROSTER_STATUS_LABEL: Record<AgentRosterStatus, string> = {
  running: "Running",
  idle: "Idle",
  blocked: "Blocked",
  archived: "Archived",
};

const AGENT_ROSTER_STATUS_TONE: Record<AgentRosterStatus, BadgeTone> = {
  running: "success",
  idle: "neutral",
  blocked: "danger",
  archived: "neutral",
};

export function agentRosterStatus(
  definition: AgentDefinition,
  instances: readonly AgentInstance[],
): AgentRosterStatus {
  if (definition.status === "stopped") return "archived";
  const own = instances.filter(
    (instance) => instance.definitionId === definition.id,
  );
  if (own.some((instance) => instance.status === "running")) return "running";
  if (own.some((instance) => instance.status === "error")) return "blocked";
  return "idle";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** How many of a definition's instances were created in the trailing 7
 * days — the roster's "Runs · 7d" column. */
export function runsInLast7Days(
  definitionId: string,
  instances: readonly AgentInstance[],
  now: number,
): number {
  return instances.filter(
    (instance) =>
      instance.definitionId === definitionId &&
      now - new Date(instance.createdAt).getTime() <= SEVEN_DAYS_MS,
  ).length;
}

const AGENT_BULK_ACTIONS = [
  { id: "duplicate", label: "Duplicate", icon: Copy },
  { id: "archive", label: "Archive", icon: Archive },
  { id: "move", label: "Move", icon: FolderOpen },
  { id: "delete", label: "Delete", icon: Trash },
] as const;

/** The short model name for a definition's capabilities — fetched lazily,
 * per row, the same route (and the same plain fetch-effect, no react-query
 * client required) `AgentDetailPanel` below already uses; a load or fetch
 * failure degrades to a dash rather than blocking the row. */
function AgentModelCell({
  tenantId,
  definitionId,
}: {
  readonly tenantId: string;
  readonly definitionId: string;
}) {
  const [capabilities, setCapabilities] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly data: AgentCapabilities }
    | { readonly status: "error" }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setCapabilities({ status: "loading" });
    getAgentCapabilities(tenantId, definitionId)
      .then((data) => {
        if (!cancelled) setCapabilities({ status: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setCapabilities({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, definitionId]);

  if (capabilities.status === "loading") {
    return <Skeleton className="h-4 w-14" />;
  }
  if (capabilities.status === "error") {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="font-mono text-xs text-muted-foreground">
      {capabilities.data.model ?? "Default"}
    </span>
  );
}

/** A workbench instance running a given agent definition — just enough to
 * link to its own settings Agents tab (`workbenchSettingsPath`), which
 * takes the workbench's own id directly, never a tenant id. */
export type DefinitionWorkbenchInstance = {
  readonly id: string;
  readonly title: string;
};

/** Definitions this bench's chats are launched against, grouped by
 * definition id — the roster's "Workbenches" column and detail panel.
 * `chats` comes from `useBenchActivity`, the same agent-DM listing the
 * sidebar itself reads; the list here is exactly which rows the sidebar
 * would show for a definition before CL-6271's dedupe-by-title collapses
 * same-named DMs across ancestor tenants. */
export function workbenchesByDefinition(
  chats: readonly {
    readonly id: string;
    readonly title: string;
    readonly definitionId?: string | null;
  }[],
): ReadonlyMap<string, readonly DefinitionWorkbenchInstance[]> {
  const byDefinition = new Map<string, DefinitionWorkbenchInstance[]>();
  for (const chat of chats) {
    if (chat.definitionId === null || chat.definitionId === undefined) {
      continue;
    }
    const list = byDefinition.get(chat.definitionId) ?? [];
    list.push({ id: chat.id, title: chat.title });
    byDefinition.set(chat.definitionId, list);
  }
  return byDefinition;
}

function AgentDetailPanel({
  tenantId,
  definition,
  workbenches,
}: {
  readonly tenantId: string;
  readonly definition: AgentDefinitionWithDisplayName;
  readonly workbenches: readonly DefinitionWorkbenchInstance[];
}) {
  const [capabilities, setCapabilities] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly data: AgentCapabilities }
    | { readonly status: "error"; readonly message: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setCapabilities({ status: "loading" });
    getAgentCapabilities(tenantId, definition.id)
      .then((data) => {
        if (!cancelled) setCapabilities({ status: "ready", data });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setCapabilities({
            status: "error",
            message: describeApiError(cause, "loading this agent's model"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, definition.id]);

  return (
    <aside className="flex min-h-0 min-w-0 flex-col gap-4 border-l border-border bg-card p-4">
      <div>
        <p className="truncate text-sm font-semibold">
          {definition.displayName}
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {definition.name}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {definition.description !== null &&
          definition.description !== undefined
            ? definition.description
            : "No description"}
        </p>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Badge tone={DEFINITION_STATUS_TONE[definition.status]}>
              {definition.status}
            </Badge>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted-foreground">Model</dt>
          <dd>
            {capabilities.status === "loading" ? (
              <Skeleton className="h-4 w-16" />
            ) : null}
            {capabilities.status === "error" ? (
              <span className="text-danger-foreground">
                {capabilities.message}
              </span>
            ) : null}
            {capabilities.status === "ready"
              ? (capabilities.data.model ?? "Default")
              : null}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-muted-foreground">Workbenches</dt>
          <dd>
            {workbenches.length === 0 ? (
              <span className="text-muted-foreground">0</span>
            ) : (
              <ul className="flex flex-col gap-1">
                {workbenches.map((workbench) => (
                  <li key={workbench.id} className="truncate">
                    <Link
                      to={workbenchSettingsPath(workbench.id, "agents")}
                      className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {workbench.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
    </aside>
  );
}

/**
 * The roster stage: a flat table of every definition this bench owns —
 * name, status, model, and how often it has run in the last week — rows,
 * never cards, per the owner's "rows over grids" rule for this slice.
 * Selecting a row opens its detail alongside the table; "New agent" opens
 * `CreateAgentPanel`. Rows are also bulk-selectable (checkbox + shift/cmd
 * range select, `useListSelection`) with a floating `BulkActionBar` for
 * Duplicate/Archive/Move/Delete — none of those four mutate anything yet
 * (the hub exposes no bulk endpoint for any of them), so each one is a
 * clearly-labelled no-op toast rather than a button that lies about doing
 * something.
 */
export function AgentsPage({
  tenantId,
  definitions,
  workbenches,
  instances,
  now = Date.now(),
  selectedId,
  onSelect,
  createOpen,
  onCreateOpenChange,
  onCreated,
}: {
  readonly tenantId: string | null;
  readonly definitions: readonly AgentDefinitionWithDisplayName[];
  readonly workbenches: ReadonlyMap<
    string,
    readonly DefinitionWorkbenchInstance[]
  >;
  readonly instances: readonly AgentInstance[];
  readonly now?: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
  readonly onCreated: (definition: AgentDefinition) => void;
}) {
  const selected = definitions.find((d) => d.id === selectedId) ?? null;
  const definitionIds = useMemo(
    () => definitions.map((definition) => definition.id),
    [definitions],
  );
  const selection = useListSelection({ ids: definitionIds });
  const allSelected =
    definitions.length > 0 && selection.selectedCount === definitions.length;
  const headerChecked: SelectionCheckboxState =
    selection.selectedCount === 0
      ? false
      : allSelected
        ? true
        : "indeterminate";

  function runBulkAction(label: string) {
    toast(`${label} isn't wired to the hub yet.`);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Agents" }]}
        subtitle={`${definitions.length} agents`}
        actions={
          tenantId !== null ? (
            <Button
              size="sm"
              onClick={() => onCreateOpenChange(true)}
              aria-label="Create an agent"
            >
              <Plus /> New agent
            </Button>
          ) : null
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          <PageShell width="full" className="page-fill">
            {definitions.length === 0 ? (
              <RichEmptyState
                icon={<Robot />}
                title="No agents yet"
                description="Create an agent — a name, a system prompt, and optionally a model — and it appears here and in the sidebar, ready to start a workbench."
              />
            ) : (
              <div className="px-4 pb-5 sm:px-7">
                <Table aria-label="Agents">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <SelectionCheckbox
                          checked={headerChecked}
                          onToggle={() =>
                            allSelected ? selection.clear() : selection.selectAll()
                          }
                          rowLabel="all agents"
                          ariaLabel="Select all agents"
                          className="opacity-100"
                        />
                      </TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Description
                      </TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Model
                      </TableHead>
                      <TableHead className="hidden text-right lg:table-cell">
                        Runs · 7d
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {definitions.map((definition) => {
                      const isSelected = selection.isSelected(definition.id);
                      const status = agentRosterStatus(definition, instances);
                      return (
                        <TableRow
                          key={definition.id}
                          data-state={
                            selectedId === definition.id
                              ? "selected"
                              : undefined
                          }
                          className="group cursor-pointer"
                          role="button"
                          tabIndex={0}
                          onClick={(event) => {
                            if (
                              event.shiftKey ||
                              isAdditiveSelectClick(event)
                            ) {
                              selection.toggle(definition.id, {
                                shiftKey: event.shiftKey,
                              });
                              return;
                            }
                            onSelect(
                              selectedId === definition.id
                                ? null
                                : definition.id,
                            );
                          }}
                          onKeyDown={(event) => {
                            if (event.key !== "Enter" && event.key !== " ") {
                              return;
                            }
                            event.preventDefault();
                            onSelect(
                              selectedId === definition.id
                                ? null
                                : definition.id,
                            );
                          }}
                        >
                          <TableCell onClick={(event) => event.stopPropagation()}>
                            <SelectionCheckbox
                              checked={isSelected}
                              onToggle={(modifiers) =>
                                selection.toggle(definition.id, modifiers)
                              }
                              rowLabel={definition.displayName}
                            />
                          </TableCell>
                          <TableCell className="font-medium">
                            <div className="flex flex-col">
                              <span className="text-[13.5px] font-bold">
                                {definition.displayName}
                              </span>
                              <span className="font-mono text-xs font-normal text-muted-foreground">
                                {definition.name}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="hidden text-muted-foreground lg:table-cell">
                            {definition.description !== null &&
                            definition.description !== undefined &&
                            definition.description !== ""
                              ? definition.description
                              : "—"}
                          </TableCell>
                          <TableCell>
                            <Badge tone={AGENT_ROSTER_STATUS_TONE[status]}>
                              {AGENT_ROSTER_STATUS_LABEL[status]}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            {tenantId !== null ? (
                              <AgentModelCell
                                tenantId={tenantId}
                                definitionId={definition.id}
                              />
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="hidden text-right tabular-nums text-muted-foreground lg:table-cell">
                            {runsInLast7Days(definition.id, instances, now)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </PageShell>
        </div>
        {selected !== null && tenantId !== null ? (
          <div className="hidden w-[min(24rem,40%)] shrink-0 md:flex md:flex-col">
            <AgentDetailPanel
              tenantId={tenantId}
              definition={selected}
              workbenches={workbenches.get(selected.id) ?? []}
            />
          </div>
        ) : null}
      </div>
      {tenantId !== null ? (
        <CreateAgentPanel
          open={createOpen}
          onOpenChange={onCreateOpenChange}
          tenantId={tenantId}
          onCreated={(definition) => {
            onCreateOpenChange(false);
            onSelect(definition.id);
            onCreated(definition);
          }}
        />
      ) : null}
      <BulkActionBar count={selection.selectedCount} onClear={selection.clear}>
        {AGENT_BULK_ACTIONS.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            type="button"
            size="sm"
            variant="outline"
            data-bulk-action={id}
            onClick={() => runBulkAction(label)}
          >
            <Icon aria-hidden="true" />
            {label}
          </Button>
        ))}
      </BulkActionBar>
    </div>
  );
}

export function AgentsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const directory = useAgentDirectory(selectedTenantId ?? undefined);
  const activity = useBenchActivity(selectedTenantId);
  // Powers the roster's Status and "Runs · 7d" columns; a failed fetch here
  // degrades those two columns to Idle/0 rather than blocking the page —
  // the definitions listing above is what makes the page usable at all.
  const runsQuery = useQuery({
    queryKey: ["agent-top-level-runs", selectedTenantId],
    queryFn: () => listTopLevelRuns(selectedTenantId as string),
    enabled: selectedTenantId !== null,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const selectedId = agentIdFromPath(path);

  if (selectedTenantId === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Agents" }]} />
        <PageShell width="full" className="page-fill">
          <RichEmptyState
            icon={<Robot />}
            title="Select a workbench"
            description="Pick a workbench from the switcher to see the agents it can start."
          />
        </PageShell>
      </div>
    );
  }

  if (directory.kind !== "ready") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Agents" }]} />
        <PageShell width="full" className="page-fill">
          <QueryView query={directory} label="your agents" skeleton="rows">
            {() => null}
          </QueryView>
        </PageShell>
      </div>
    );
  }

  const definitions = purposeAgentDefinitions(directory.data.definitions);
  const workbenches = workbenchesByDefinition(
    activity.kind === "ready" ? activity.chats : [],
  );

  return (
    <AgentsPage
      tenantId={selectedTenantId}
      definitions={definitions}
      workbenches={workbenches}
      instances={runsQuery.data ?? []}
      selectedId={selectedId}
      onSelect={(id) =>
        navigate(
          id === null
            ? AGENTS_PATH_PREFIX
            : `${AGENTS_PATH_PREFIX}/${encodeURIComponent(id)}`,
        )
      }
      createOpen={createOpen}
      onCreateOpenChange={setCreateOpen}
      onCreated={() => {
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.agentDirectory(selectedTenantId),
        });
      }}
    />
  );
}
