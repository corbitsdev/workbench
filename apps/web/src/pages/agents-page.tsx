import {
  Badge,
  Button,
  Card,
  EmptyState,
  LibrarySearchInput,
  PageShell,
  RichEmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  ViewToggle,
  formatRelativeTime,
} from "@corbits/react-ui";
import type { BadgeTone, ViewMode } from "@corbits/react-ui";
import { Bot, Copy, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import type { AgentDefinition, AgentInstance } from "../agents-api";
import type { AgentDirectoryData } from "../agents-api";
import type { APIQuery } from "../api";
import { useAgentDirectory } from "../agents-api";
import { useBench } from "../bench-context";
import { tenantKeys } from "../query-client";
import { QueryView } from "../query-view";
import { CreateAgentDialog } from "./create-agent-dialog";
import {
  definitionsById,
  filterDefinitions,
  filterInstances,
  isOrphanedInstance,
  purposeAgentDefinitions,
  purposeAgentInstances,
} from "./agents-directory";

const DEFINITION_STATUS_TONE: Record<AgentDefinition["status"], BadgeTone> = {
  deployed: "success",
  stopped: "neutral",
};

const INSTANCE_STATUS_TONE: Record<AgentInstance["status"], BadgeTone> = {
  running: "success",
  deployed: "info",
  updating: "info",
  stopped: "neutral",
  error: "danger",
};

const INSTANCE_CAP = 4;

/** Copies an instance's mailbox address to the clipboard on demand —
 * the only way this page ever exposes it. The address never renders as
 * visible text anywhere on this surface. */
function CopyAddressButton({ address }: { readonly address: string }) {
  const [copied, setCopied] = useState(false);
  // The "Copied" confirmation clears itself after a timeout. Track that
  // timer so unmounting the button (switching tabs, leaving the page) can
  // cancel it — otherwise the callback fires setState on an unmounted
  // component, the classic leak.
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    };
  }, []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title="Copy mailbox address"
      aria-label="Copy mailbox address"
      onClick={() => {
        void navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          if (resetTimer.current !== null) clearTimeout(resetTimer.current);
          resetTimer.current = setTimeout(() => {
            resetTimer.current = null;
            setCopied(false);
          }, 1500);
        });
      }}
    >
      <Copy /> {copied ? "Copied" : "Copy address"}
    </Button>
  );
}

function InstanceBadges({
  instances,
}: {
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
}) {
  if (instances.length === 0) {
    return <span className="text-sm text-muted-foreground">No instances</span>;
  }
  const shown = instances.slice(0, INSTANCE_CAP);
  const overflow = instances.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((instance) => (
        <Badge key={instance.id} tone={INSTANCE_STATUS_TONE[instance.status]}>
          {instance.status}
        </Badge>
      ))}
      {overflow > 0 && (
        <span className="text-xs text-muted-foreground">+{overflow} more</span>
      )}
    </span>
  );
}

function DefinitionCard({
  definition,
  instances,
}: {
  readonly definition: AgentDefinition;
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
}) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="truncate font-semibold">{definition.name}</span>
        <Badge tone={DEFINITION_STATUS_TONE[definition.status]}>
          {definition.status}
        </Badge>
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] text-sm text-muted-foreground">
        {definition.description ?? "No description"}
      </p>
      <InstanceBadges instances={instances} />
    </Card>
  );
}

function DefinitionRows({
  definitions,
  instancesByDefinition,
}: {
  readonly definitions: readonly AgentDefinition[];
  readonly instancesByDefinition: ReadonlyMap<
    string,
    readonly (AgentInstance & { readonly orphaned: boolean })[]
  >;
}) {
  return (
    <Table aria-label="Agent definitions">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Description</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Instances</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {definitions.map((definition) => (
          <TableRow key={definition.id}>
            <TableCell className="font-medium">{definition.name}</TableCell>
            <TableCell className="max-w-xs truncate text-muted-foreground">
              {definition.description ?? "—"}
            </TableCell>
            <TableCell>
              <Badge tone={DEFINITION_STATUS_TONE[definition.status]}>
                {definition.status}
              </Badge>
            </TableCell>
            <TableCell>
              <InstanceBadges
                instances={instancesByDefinition.get(definition.id) ?? []}
              />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function InstanceCard({
  instance,
  now,
}: {
  readonly instance: AgentInstance & { readonly orphaned: boolean };
  readonly now: number;
}) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="truncate font-semibold">
          {instance.definitionName}
        </span>
        <Badge tone={INSTANCE_STATUS_TONE[instance.status]}>
          {instance.status}
        </Badge>
      </div>
      {instance.orphaned && (
        <Badge tone="danger" className="w-fit">
          Unlinked definition
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">
        Started {formatRelativeTime(instance.createdAt, now)}
      </span>
      <CopyAddressButton address={instance.address} />
    </Card>
  );
}

function InstanceRows({
  instances,
  now,
}: {
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
  readonly now: number;
}) {
  return (
    <Table aria-label="Agent instances">
      <TableHeader>
        <TableRow>
          <TableHead>Agent</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Mailbox</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {instances.map((instance) => (
          <TableRow key={instance.id}>
            <TableCell className="font-medium">
              <span className="flex items-center gap-2">
                {instance.definitionName}
                {instance.orphaned && (
                  <Badge tone="danger">Unlinked definition</Badge>
                )}
              </span>
            </TableCell>
            <TableCell>
              <Badge tone={INSTANCE_STATUS_TONE[instance.status]}>
                {instance.status}
              </Badge>
            </TableCell>
            <TableCell className="text-muted-foreground">
              {formatRelativeTime(instance.createdAt, now)}
            </TableCell>
            <TableCell>
              <CopyAddressButton address={instance.address} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type AgentsTab = "definitions" | "instances";

export function AgentsPage({
  directory,
  onAgentCreated,
  now = Date.now(),
  initialTab = "definitions",
}: {
  readonly directory: APIQuery<AgentDirectoryData>;
  readonly onAgentCreated: (definition: AgentDefinition) => void;
  /** Reference time for relative timestamps; injectable for tests. */
  readonly now?: number;
  /** Which tab is active on first render; injectable for tests that need
   * to inspect the instances panel without a click. */
  readonly initialTab?: AgentsTab;
}) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [tab, setTab] = useState<AgentsTab>(initialTab);
  const [createOpen, setCreateOpen] = useState(false);
  const canCreate =
    directory.kind === "ready" && directory.data.tenantId !== "";

  useEffect(() => {
    const onCreate = () => {
      if (canCreate) setCreateOpen(true);
    };
    window.addEventListener("workbench:agents:create", onCreate);
    return () =>
      window.removeEventListener("workbench:agents:create", onCreate);
  }, [canCreate]);

  return (
    <>
      <div className="page-toolbar">
        <LibrarySearchInput
          label="Search agents"
          value={query}
          onChange={setQuery}
        />
        <ViewToggle mode={viewMode} onChange={setViewMode} />
      </div>
      <PageShellBody>
        <QueryView query={directory} label="your agents">
          {(data) => {
            const definitions = purposeAgentDefinitions(data.definitions);
            const instances = purposeAgentInstances(data.instances).map(
              (instance) => ({
                ...instance,
                orphaned: isOrphanedInstance(
                  instance,
                  definitionsById(definitions),
                ),
              }),
            );
            const visibleDefinitions = filterDefinitions(definitions, query);
            const visibleInstances = filterInstances(instances, query);
            const instancesByDefinition = new Map<
              string,
              (AgentInstance & { readonly orphaned: boolean })[]
            >();
            for (const instance of instances) {
              const list = instancesByDefinition.get(instance.definitionId);
              if (list === undefined) {
                instancesByDefinition.set(instance.definitionId, [instance]);
              } else {
                list.push(instance);
              }
            }

            if (definitions.length === 0 && instances.length === 0) {
              return (
                <RichEmptyState
                  icon={<Bot />}
                  title="No agents yet"
                  description="Create your first agent — a name, a system prompt, and optionally a model — and it appears here immediately, ready to invite into a channel."
                  actions={[
                    {
                      label: "Create agent",
                      onClick: () => setCreateOpen(true),
                      variant: "primary",
                    },
                  ]}
                />
              );
            }

            return (
              <Tabs
                tabs={[
                  {
                    id: "definitions",
                    label: "Definitions",
                    count: visibleDefinitions.length,
                  },
                  {
                    id: "instances",
                    label: "Instances",
                    count: visibleInstances.length,
                  },
                ]}
                active={tab}
                onChange={setTab}
                label="Agent views"
              >
                {(active) => {
                  if (active === "definitions") {
                    if (visibleDefinitions.length === 0) {
                      return (
                        <EmptyState
                          icon={<Bot />}
                          title="Nothing matches"
                          description={`No agent definition matches "${query}".`}
                        />
                      );
                    }
                    return viewMode === "rows" ? (
                      <div className="px-4 pb-5 sm:px-7">
                        <DefinitionRows
                          definitions={visibleDefinitions}
                          instancesByDefinition={instancesByDefinition}
                        />
                      </div>
                    ) : (
                      <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 px-4 pb-5 sm:px-7">
                        {visibleDefinitions.map((definition) => (
                          <DefinitionCard
                            key={definition.id}
                            definition={definition}
                            instances={
                              instancesByDefinition.get(definition.id) ?? []
                            }
                          />
                        ))}
                      </div>
                    );
                  }
                  if (visibleInstances.length === 0) {
                    return (
                      <EmptyState
                        icon={<Workflow />}
                        title="Nothing matches"
                        description={
                          instances.length === 0
                            ? "No agent instance is deployed in this bench yet. Invite a definition into a channel to launch one."
                            : `No agent instance matches "${query}".`
                        }
                      />
                    );
                  }
                  return viewMode === "rows" ? (
                    <div className="px-4 pb-5 sm:px-7">
                      <InstanceRows instances={visibleInstances} now={now} />
                    </div>
                  ) : (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3 px-4 pb-5 sm:px-7">
                      {visibleInstances.map((instance) => (
                        <InstanceCard
                          key={instance.id}
                          instance={instance}
                          now={now}
                        />
                      ))}
                    </div>
                  );
                }}
              </Tabs>
            );
          }}
        </QueryView>
      </PageShellBody>
      {canCreate && (
        <CreateAgentDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={directory.data.tenantId}
          models={directory.data.models}
          {...(directory.data.modelsError !== undefined
            ? { modelsError: directory.data.modelsError }
            : {})}
          onCreated={onAgentCreated}
        />
      )}
    </>
  );
}

// A thin, named wrapper around `PageShell` so the two very different
// child shapes above (`RichEmptyState`/`Tabs`) share one shell call
// site instead of duplicating its props at both return points.
function PageShellBody({ children }: { readonly children: ReactNode }) {
  return (
    <PageShell width="full" className="page-fill">
      {children}
    </PageShell>
  );
}

export function AgentsRoute() {
  // BenchProvider is the only source of the active tenant — never re-fetch
  // /api/me/principals and take memberships[0], which ignores the switcher.
  const { memberships, selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const directory = useAgentDirectory(selectedTenantId ?? undefined);

  const resolvedDirectory: APIQuery<AgentDirectoryData> =
    memberships.kind !== "ready"
      ? memberships
      : selectedTenantId === null
        ? {
            kind: "ready",
            data: {
              tenantId: "",
              definitions: [],
              instances: [],
              models: [],
            },
          }
        : directory;

  return (
    <AgentsPage
      directory={resolvedDirectory}
      onAgentCreated={() => {
        if (selectedTenantId === null) return;
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.agentDirectory(selectedTenantId),
        });
      }}
    />
  );
}
