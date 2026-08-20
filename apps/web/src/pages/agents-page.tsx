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
  Button,
  PageShell,
  RichEmptyState,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Robot } from "@corbits/icons";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { describeApiError, QueryView } from "@corbits/api-query";

import {
  getAgentCapabilities,
  useAgentDirectory,
  type AgentCapabilities,
  type AgentDefinition,
} from "../agents-api";
import {
  purposeAgentDefinitions,
  type AgentDefinitionWithDisplayName,
} from "../agents-directory";
import { useBench } from "../bench-context";
import { rowActivationProps } from "../activatable-row";
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
 * name, description, and how many open workbenches (agent DMs) currently
 * run it — rows, never cards, per the owner's "rows over grids" rule for
 * this slice. Selecting a row opens its detail alongside the table; "Create"
 * opens `CreateAgentPanel`. There is no second "New agent" mint action here
 * — creating an agent stays the one workbench-creation verb the rest of
 * the shell already offers.
 */
export function AgentsPage({
  tenantId,
  definitions,
  workbenches,
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
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly createOpen: boolean;
  readonly onCreateOpenChange: (open: boolean) => void;
  readonly onCreated: (definition: AgentDefinition) => void;
}) {
  const selected = definitions.find((d) => d.id === selectedId) ?? null;

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
              <Robot /> Create
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
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Workbenches</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {definitions.map((definition) => (
                      <TableRow
                        key={definition.id}
                        data-state={
                          selectedId === definition.id ? "selected" : undefined
                        }
                        className="cursor-pointer"
                        {...rowActivationProps(() =>
                          onSelect(
                            selectedId === definition.id ? null : definition.id,
                          ),
                        )}
                      >
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{definition.displayName}</span>
                            <span className="font-mono text-xs font-normal text-muted-foreground">
                              {definition.name}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {definition.description !== null &&
                          definition.description !== undefined &&
                          definition.description !== ""
                            ? definition.description
                            : "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {workbenches.get(definition.id)?.length ?? 0}
                        </TableCell>
                      </TableRow>
                    ))}
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
