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
  formatRelativeTime,
  toast,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Bot, Copy, MessageSquare, Plus, Search, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createChannel } from "@corbits/chat-ui";

import {
  updateAgentSkills,
  useAgentDirectory,
  type AgentDefinition,
  type AgentDirectoryData,
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
import { launchAgentChat } from "../agent-chat-launch";
import { consumePendingNewAgent } from "../command-palette-actions";
import { tenantKeys } from "../query-client";
import { ListSkeleton } from "@corbits/api-query";
import { AgentSkillsPicker } from "./agent-skills-picker";
import { CreateAgentPanel } from "./create-agent-panel";

/** A row of skill chips, or nothing at all when a definition carries none —
 * this never renders an empty "Skills" label for the common case. */
function SkillChips({ skills }: { readonly skills: readonly string[] }) {
  if (skills.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {skills.map((skill) => (
        <Badge key={skill} tone="neutral">
          {skill}
        </Badge>
      ))}
    </div>
  );
}

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

/** The definition's attached skills: a chip row, and an "Edit" toggle that
 * swaps in the same checkbox picker the create dialog uses. Saving PUTs the
 * full replacement set and hands the result back to the parent so the list
 * and detail panel stay in sync without a full directory refetch. */
function AgentSkillsSection({
  tenantId,
  definitionId,
  skills,
  onSkillsUpdated,
}: {
  readonly tenantId: string;
  readonly definitionId: string;
  readonly skills: readonly string[];
  readonly onSkillsUpdated: (next: readonly string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<readonly string[]>(skills);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft(skills);
    setError(null);
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const saved = await updateAgentSkills(tenantId, definitionId, draft);
      onSkillsUpdated(saved);
      setEditing(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">Skills</h3>
        {!editing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startEditing}
          >
            Edit skills
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <AgentSkillsPicker
            tenantId={tenantId}
            selected={draft}
            onChange={setDraft}
            idPrefix={`agent-${definitionId}`}
            disabled={saving}
          />
          {error !== null && (
            <p className="text-sm text-danger-foreground" role="alert">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? "Saving…" : "Save skills"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : skills.length === 0 ? (
        <span className="text-sm text-muted-foreground">
          No skills attached.
        </span>
      ) : (
        <SkillChips skills={skills} />
      )}
    </Card>
  );
}

/** The agent detail: full description, lifecycle status, version, the
 * definition's deployed instances, and the two launch actions — Start chat
 * and Open in channel — the only ways this section reaches into chat. */
function AgentDetailPanel({
  definition,
  instances,
  skills,
  onSkillsUpdated,
  tenantId,
  now,
  navigate,
}: {
  readonly definition: AgentDefinition;
  readonly instances: readonly (AgentInstance & {
    readonly orphaned: boolean;
  })[];
  readonly skills: readonly string[];
  readonly onSkillsUpdated: (next: readonly string[]) => void;
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
            aria-label="Open in a chat"
          >
            <Users /> Open in chat
          </Button>
        </div>
        {error !== null && (
          <p className="text-sm text-danger-foreground" role="alert">
            {error}
          </p>
        )}
      </Card>

      <AgentSkillsSection
        tenantId={tenantId}
        definitionId={definition.id}
        skills={skills}
        onSkillsUpdated={onSkillsUpdated}
      />

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-muted-foreground">
          Active agents ({instances.length})
        </h3>
        {instances.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            No active agents. Use Start chat to launch one.
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
        title="No workbench selected"
        description="Choose a workbench from the switcher to see its agents."
      />
    );
  }

  if (directory.kind === "loading") {
    return <ListSkeleton />;
  }
  if (directory.kind === "unauthenticated") {
    return (
      <EmptyState
        icon={<Bot />}
        title="Sign in required"
        description="Sign in to see agents for this workbench."
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
      <CreateAgentPanel
        open={createOpen}
        onOpenChange={setCreateOpen}
        tenantId={directory.data.tenantId}
        onCreated={(definition) => {
          void queryClient.invalidateQueries({
            queryKey: tenantKeys.agentDirectory(directory.data.tenantId),
          });
          if (navigate === undefined) {
            select(definition.id);
            return;
          }
          launchAgentChat(directory.data.tenantId, definition.id, navigate).catch(
            () => {
              toast("Created the agent, but couldn't open a chat with it.");
              select(definition.id);
            },
          );
        }}
      />
    ) : null;

  if (definitions.length === 0 && instances.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <RichEmptyState
          icon={<Bot />}
          title="No agents yet"
          description="Create your first agent — a name, a system prompt, and optionally a model — and it appears here, ready to start a chat or invite into one."
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

  const directoryQueryKey = tenantKeys.agentDirectory(directory.data.tenantId);
  function handleSkillsUpdated(
    definitionId: string,
    skills: readonly string[],
  ) {
    queryClient.setQueryData(
      directoryQueryKey,
      (previous: AgentDirectoryData | undefined) =>
        previous === undefined
          ? previous
          : {
              ...previous,
              definitionSkills: {
                ...previous.definitionSkills,
                [definitionId]: skills,
              },
            },
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
          skills={directory.data.definitionSkills[selected.id] ?? []}
          onSkillsUpdated={(skills) => handleSkillsUpdated(selected.id, skills)}
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
                  <SkillChips
                    skills={
                      directory.data.definitionSkills[definition.id] ?? []
                    }
                  />
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
