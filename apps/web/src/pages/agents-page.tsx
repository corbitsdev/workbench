import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageShell,
  RichEmptyState,
  formatRelativeTime,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { ArrowLeft, Bot, Copy, MessageSquare, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createChannel } from "@corbits/chat-ui";

import {
  useAgentDirectory,
  type AgentDefinition,
  type AgentDirectoryData,
  type AgentInstance,
} from "../agents-api";
import {
  definitionsById,
  isOrphanedInstance,
  purposeAgentDefinitions,
  purposeAgentInstances,
} from "../agents-directory";
import type { APIQuery } from "../api";
import { useBench } from "../bench-context";
import { channelPath } from "../channel-path";
import { AGENTS_PATH_PREFIX, agentIdFromPath } from "../path-ids";
import { tenantKeys } from "../query-client";
import { QueryView } from "../query-view";
import { CreateAgentDialog } from "./create-agent-dialog";

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

/** The agent detail panel: shown when a definition is selected from col2.
 * Renders the full description, lifecycle status, version, the definition's
 * deployed instances, and the two launch actions — Start chat and Open in
 * channel. */
function AgentDetailPanel({
  definition,
  instances,
  tenantId,
  now,
  onBack,
  onChatStarted,
  navigate,
}: {
  readonly definition: AgentDefinition;
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
  readonly tenantId: string;
  readonly now: number;
  readonly onBack: () => void;
  readonly onChatStarted: (channelId: string) => void;
  readonly navigate: ((to: string) => void) | undefined;
}) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStartChat() {
    if (tenantId === "") return;
    setStarting(true);
    setError(null);
    try {
      const channel = await createChannel(tenantId, {
        kind: "chat",
        definitionId: definition.id,
      });
      const target = channelPath(channel.id);
      onChatStarted(channel.id);
      navigate?.(target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  function handleOpenInChannel() {
    navigate?.(channelPath(null));
  }

  return (
    <div
      className="flex flex-col gap-4 px-4 pb-5 sm:px-7"
      data-testid="agent-detail-panel"
    >
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to agent list"
        >
          <ArrowLeft /> Back
        </Button>
      </div>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-xl font-semibold">{definition.name}</h2>
          <Badge tone={DEFINITION_STATUS_TONE[definition.status]}>
            {definition.status}
          </Badge>
        </div>
        <div className="flex flex-col gap-1 text-sm text-muted-foreground">
          <span>
            <span className="font-medium text-foreground">Version:</span>{" "}
            {definition.currentVersion}
          </span>
          {definition.description !== null &&
            definition.description !== undefined && (
              <p className="leading-relaxed">{definition.description}</p>
            )}
          {(definition.description === null ||
            definition.description === undefined) && (
            <span className="italic">No description</span>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={starting || tenantId === ""}
            onClick={() => void handleStartChat()}
            aria-label="Start chat with this agent"
          >
            <MessageSquare /> {starting ? "Starting…" : "Start chat"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={tenantId === ""}
            onClick={handleOpenInChannel}
            aria-label="Open in a channel"
          >
            <Users /> Open in channel
          </Button>
        </div>
        {error !== null && (
          <p className="text-sm text-danger-foreground" role="alert">
            {error}
          </p>
        )}
      </Card>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Instances ({instances.length})
        </h3>
        {instances.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No instances deployed. Use Start chat to launch one.
          </span>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
            {instances.map((instance) => (
              <InstanceCard key={instance.id} instance={instance} now={now} />
            ))}
          </div>
        )}
      </div>
    </div>
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

/**
 * Agents stage: list lives in shell col2; stage is detail only (or empty
 * "select from sidebar"). Create is pageBand / workbench:agents:create.
 */
export function AgentsPage({
  directory,
  onAgentCreated,
  now = Date.now(),
  path = AGENTS_PATH_PREFIX,
  navigate,
  initialSelectedDefinitionId,
}: {
  readonly directory: APIQuery<AgentDirectoryData>;
  readonly onAgentCreated: (definition: AgentDefinition) => void;
  /** Reference time for relative timestamps; injectable for tests. */
  readonly now?: number;
  /** Current location — selection is `/agents/:id`. */
  readonly path?: string;
  /** Client-side navigation; Start chat / Open in channel / back rely on this. */
  readonly navigate?: (to: string) => void;
  /** Which definition is expanded on first render when path has no id;
   * injectable for tests that assert detail markup without routing. */
  readonly initialSelectedDefinitionId?: string;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const pathSelectedId = agentIdFromPath(path);
  const selectedDefinitionId =
    pathSelectedId ?? initialSelectedDefinitionId ?? null;
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
      {/* List lives in shell col2; stage is detail only. Create is
          pageBand / workbench:agents:create — no stage list chrome. */}
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
                <div className="flex flex-1 items-center justify-center p-6">
                  <RichEmptyState
                    icon={<Bot />}
                    title="No agents yet"
                    description="Create your first agent — a name, a system prompt, and optionally a model — and it appears in the sidebar, ready to start a chat or invite into a channel."
                    actions={
                      canCreate
                        ? [
                            {
                              label: "Create agent",
                              onClick: () => setCreateOpen(true),
                              variant: "primary",
                            },
                          ]
                        : []
                    }
                  />
                </div>
              );
            }

            const selectedDefinition =
              selectedDefinitionId !== null
                ? (definitions.find((d) => d.id === selectedDefinitionId) ??
                  null)
                : null;

            if (selectedDefinition !== null) {
              return (
                <AgentDetailPanel
                  definition={selectedDefinition}
                  instances={
                    instancesByDefinition.get(selectedDefinition.id) ?? []
                  }
                  tenantId={data.tenantId}
                  now={now}
                  onBack={() => navigate?.(AGENTS_PATH_PREFIX)}
                  onChatStarted={() => {
                    /* parent may invalidate chat queries; no-op by default */
                  }}
                  navigate={navigate}
                />
              );
            }

            if (selectedDefinitionId !== null) {
              return (
                <div className="flex flex-1 items-center justify-center p-6">
                  <EmptyState
                    icon={<Bot />}
                    title="Agent not found"
                    description="That definition is not on this bench. Pick another from the sidebar."
                  />
                </div>
              );
            }

            return (
              <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState
                  icon={<Bot />}
                  title="Select an agent"
                  description="Pick an agent from the sidebar to see its details and instances."
                />
              </div>
            );
          }}
        </QueryView>
      </PageShellBody>
      {canCreate && directory.kind === "ready" ? (
        <CreateAgentDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={directory.data.tenantId}
          models={directory.data.models}
          {...(directory.data.modelsError !== undefined
            ? { modelsError: directory.data.modelsError }
            : {})}
          onCreated={(definition) => {
            onAgentCreated(definition);
            navigate?.(
              `${AGENTS_PATH_PREFIX}/${encodeURIComponent(definition.id)}`,
            );
          }}
        />
      ) : null}
    </>
  );
}

// A thin, named wrapper around `PageShell` so empty / select / detail
// shapes share one shell call site.
function PageShellBody({ children }: { readonly children: ReactNode }) {
  return (
    <PageShell width="full" className="page-fill">
      {children}
    </PageShell>
  );
}

export function AgentsRoute({
  path,
  navigate,
}: {
  readonly path: string;
  readonly navigate: (to: string) => void;
}) {
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
      path={path}
      navigate={navigate}
      onAgentCreated={() => {
        if (selectedTenantId === null) return;
        void queryClient.invalidateQueries({
          queryKey: tenantKeys.agentDirectory(selectedTenantId),
        });
      }}
    />
  );
}
