// Settings · Agents: definitions only (CL-5990 owner ruling — talking to an
// agent is a chat, looping one into a conversation is a channel mention;
// this section is strictly the directory: create, browse, and each
// definition's deployed instances). Formerly its own rail destination
// (`/agents`, `agents-page.tsx` + shell col2's `AgentsFeedBand`); both the
// stage detail and the list now live together here, self-contained, since a
// settings section has no col2 list slot of its own.

import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  RichEmptyState,
  SidebarItemRow,
  Skeleton,
  formatRelativeTime,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Bot, Copy, MessageSquare, Plus, Search, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createChannel } from "@corbits/chat-ui";

import {
  useAgentDirectory,
  type AgentDefinition,
  type AgentInstance,
} from "../agents-api";
import {
  definitionsById,
  filterDefinitions,
  isOrphanedInstance,
  purposeAgentDefinitions,
  purposeAgentInstances,
} from "../agents-directory";
import { channelPath } from "../channel-path";
import { consumePendingNewAgent } from "../command-palette-actions";
import { tenantKeys } from "../query-client";
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

/** Copies an instance's mailbox address to the clipboard on demand — the
 * only way this section ever exposes it. The address never renders as
 * visible text anywhere on this surface. */
function CopyAddressButton({ address }: { readonly address: string }) {
  const [copied, setCopied] = useState(false);
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

/** The agent detail: full description, lifecycle status, version, the
 * definition's deployed instances, and the two launch actions — Start chat
 * and Open in channel — the only ways this section reaches into chat. */
function AgentDetailPanel({
  definition,
  instances,
  tenantId,
  now,
  navigate,
}: {
  readonly definition: AgentDefinition;
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
  readonly tenantId: string;
  readonly now: number;
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
      navigate?.(channelPath(channel.id));
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
    <div className="flex flex-col gap-4" data-testid="agent-detail-panel">
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

/**
 * Settings · Agents: definitions only. `tenantId`, `navigate`, and
 * `entityId` come from the settings section context (see
 * `../settings-workspace-sections.tsx`); this component owns its own
 * fetch, search, selection, and create dialog since a settings section has
 * no separate col2 list to lean on.
 */
export function AgentsSettingsSection({
  tenantId,
  navigate,
  entityId,
  now = Date.now(),
}: {
  readonly tenantId: string | null;
  readonly navigate?: (to: string) => void;
  readonly entityId?: string | null;
  readonly now?: number;
}) {
  const directory = useAgentDirectory(tenantId ?? undefined);
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(entityId ?? null);
  const [createOpen, setCreateOpen] = useState(false);
  const canCreate = tenantId !== null;

  useEffect(() => {
    if (canCreate && consumePendingNewAgent()) setCreateOpen(true);
  }, [canCreate]);

  useEffect(() => {
    const onCreate = () => {
      if (canCreate) setCreateOpen(true);
    };
    window.addEventListener("workbench:agents:create", onCreate);
    return () =>
      window.removeEventListener("workbench:agents:create", onCreate);
  }, [canCreate]);

  function select(id: string | null) {
    setSelectedId(id);
    navigate?.(
      id === null
        ? "/settings/agents"
        : `/settings/agents/${encodeURIComponent(id)}`,
    );
  }

  if (tenantId === null) {
    return (
      <EmptyState
        icon={<Bot />}
        title="No bench selected"
        description="Choose a bench from the rail to see its agents."
      />
    );
  }

  if (directory.kind === "loading") {
    return <Skeleton className="query-skeleton" />;
  }
  if (directory.kind === "unauthenticated") {
    return (
      <EmptyState
        icon={<Bot />}
        title="Sign in required"
        description="Sign in to see agents for this bench."
      />
    );
  }
  if (directory.kind === "error") {
    return (
      <EmptyState
        icon={<Bot />}
        title="Couldn't load agents"
        description={directory.message}
      />
    );
  }

  const definitions = purposeAgentDefinitions(directory.data.definitions);
  const instances = purposeAgentInstances(directory.data.instances).map(
    (instance) => ({
      ...instance,
      orphaned: isOrphanedInstance(instance, definitionsById(definitions)),
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

  const selected =
    selectedId !== null
      ? (definitions.find((d) => d.id === selectedId) ?? null)
      : null;

  const createDialog =
    canCreate && directory.data.tenantId !== "" ? (
      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        tenantId={directory.data.tenantId}
        models={directory.data.models}
        {...(directory.data.modelsError !== undefined
          ? { modelsError: directory.data.modelsError }
          : {})}
        onCreated={(definition) => {
          void queryClient.invalidateQueries({
            queryKey: tenantKeys.agentDirectory(directory.data.tenantId),
          });
          select(definition.id);
        }}
      />
    ) : null;

  if (definitions.length === 0 && instances.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <RichEmptyState
          icon={<Bot />}
          title="No agents yet"
          description="Create your first agent — a name, a system prompt, and optionally a model — and it appears here, ready to start a chat or invite into a channel."
          actions={[
            {
              label: "New agent",
              variant: "primary",
              onClick: () => setCreateOpen(true),
            },
          ]}
        />
        {createDialog}
      </div>
    );
  }

  if (selected !== null) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" onClick={() => select(null)}>
            All agents
          </Button>
        </div>
        <AgentDetailPanel
          definition={selected}
          instances={instancesByDefinition.get(selected.id) ?? []}
          tenantId={directory.data.tenantId}
          now={now}
          navigate={navigate}
        />
        {createDialog}
      </div>
    );
  }

  const filtered = filterDefinitions(definitions, query);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <label className="shell-panel-search">
          <Search aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            aria-label="Search agents"
          />
        </label>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus /> New agent
        </Button>
      </div>
      {filtered.length === 0 ? (
        <EmptyState
          icon={<Bot />}
          title="No matching agents"
          description={`Nothing matches “${query.trim()}”.`}
        />
      ) : (
        <div className="flex flex-col gap-1">
          {filtered.map((definition) => (
            <SidebarItemRow
              key={definition.id}
              leading={<Bot />}
              name={
                <span className="panel-row-copy">
                  <strong>{definition.name}</strong>
                  <span>v{definition.currentVersion}</span>
                </span>
              }
              meta={
                <span
                  className={
                    definition.status === "deployed"
                      ? "panel-status is-ok"
                      : "panel-status is-muted"
                  }
                >
                  {definition.status}
                </span>
              }
              onSelect={() => select(definition.id)}
            />
          ))}
        </div>
      )}
      {createDialog}
    </div>
  );
}
