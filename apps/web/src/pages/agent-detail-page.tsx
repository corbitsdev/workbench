// The agent's own page (CL-6414), addressed by its immutable slug —
// `/agents/<slug>`. Everything a person can author about an agent lives
// here: its display name, the model it resolves against, the system prompt
// it follows on every turn, the skills it has pinned, and the runs it has
// produced. It replaces the roster's quick-peek panel, which had outgrown
// being a panel (DESIGN.md, "Detail Pages").
//
// Every write goes through a mutation that already existed
// (`@corbits/agent-directory`'s routes, via `../agents-api.ts`) — this page
// invents no write path of its own:
//
//   display name + system prompt  PUT  /agent-definitions/:id
//   default model                 POST /agent-definitions/:id/capabilities
//   pinned skills                 PUT  /agent-definitions/:id/skills
//   archive / restore             PUT  /agent-definitions/:id/status
//   duplicate                     POST /agent-definitions
//
// One Save writes every dirty part, in that order, and nothing else — an
// untouched field is never rewritten. Two fields a person might expect are
// deliberately absent: the slug (immutable by design, so it renders as
// muted mono text rather than an input) and a separate description. A
// definition's row `description` IS its display name — that is where
// `deriveDisplayName` reads it from — and the purpose blurb inside the
// definition's own `workflow.json` has neither a read nor a write route
// today, so this page shows no description field rather than a control
// that silently edits the display name twice. Delete is likewise absent:
// archiving is the reversible lifecycle the platform actually backs, and
// tearing down a definition's asset and history has no route.

import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  PageShell,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Copy, Robot } from "@corbits/icons";
import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { describeApiError, QueryView } from "@corbits/api-query";
import { RichEmptyState } from "@corbits/react-ui";

import type {
  AgentDefinitionDetail,
  AgentInstance,
  CatalogModel,
} from "../agents-api";
import {
  getAgentDefinitionDetail,
  useAgentDirectory,
  createAgentDefinition,
  setAgentDefinitionStatus,
  setAgentModel,
  updateAgentInstructions,
  updateAgentSkills,
} from "../agents-api";
import type { AgentDefinitionWithDisplayName } from "../agents-directory";
import { purposeAgentDefinitions } from "../agents-directory";
import { useBench } from "../bench-context";
import { runDetailPath } from "../insights-deeplinks";
import { Link } from "../navigation";
import { AGENTS_PATH_PREFIX } from "../path-ids";
import { tenantKeys } from "../query-client";
import { StageTopBar } from "../shell/stage-top-bar";
import { AgentSkillsPicker } from "./agent-skills-picker";
import { slugify } from "./create-agent-panel";

const STATUS_TONE: Record<"deployed" | "stopped", BadgeTone> = {
  deployed: "success",
  stopped: "neutral",
};

const RUN_STATUS_TONE: Record<AgentInstance["status"], BadgeTone> = {
  deployed: "success",
  running: "success",
  updating: "warning",
  error: "danger",
  stopped: "neutral",
};

/** How many of a definition's runs the page lists. Recent history, not a
 * runs browser — Insights owns that surface, and every row here links
 * into it. */
const RECENT_RUN_LIMIT = 10;

function sameSkillSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/** The runs to show for a definition: its own, newest first, capped. */
export function recentRunsForDefinition(
  runs: readonly AgentInstance[],
  definitionId: string,
): readonly AgentInstance[] {
  return runs
    .filter((run) => run.definitionId === definitionId)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, RECENT_RUN_LIMIT);
}

/** The handle a duplicate is created under: the original's slug plus a
 * `-copy` suffix, kebab-safe. A second duplicate collides on the handle
 * and surfaces the route's own 409 rather than guessing `-copy-2`. */
export function duplicateHandle(slug: string): string {
  return slugify(`${slug}-copy`);
}

type WriteState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "error"; readonly message: string };

export function AgentDetailPage({
  tenantId,
  definition,
  detail,
  models,
  runs,
  onSaved,
  onDuplicated,
  onStatusChanged,
}: {
  readonly tenantId: string;
  readonly definition: AgentDefinitionWithDisplayName;
  readonly detail: AgentDefinitionDetail;
  readonly models: readonly CatalogModel[];
  readonly runs: readonly AgentInstance[];
  readonly onSaved: () => void;
  readonly onDuplicated: (slug: string) => void;
  readonly onStatusChanged: () => void;
}) {
  const [displayName, setDisplayName] = useState(detail.name);
  const [systemPrompt, setSystemPrompt] = useState(detail.systemPrompt);
  const [model, setModel] = useState(detail.model ?? "");
  const [skills, setSkills] = useState<readonly string[]>(detail.skills);
  const [save, setSave] = useState<WriteState>({ kind: "idle" });
  const [lifecycle, setLifecycle] = useState<WriteState>({ kind: "idle" });

  const archived = definition.status === "stopped";
  const trimmedName = displayName.trim();
  const trimmedPrompt = systemPrompt.trim();
  const instructionsDirty =
    trimmedName !== detail.name || trimmedPrompt !== detail.systemPrompt;
  const modelDirty = model !== "" && model !== (detail.model ?? "");
  const skillsDirty = !sameSkillSet(skills, detail.skills);
  const dirty = instructionsDirty || modelDirty || skillsDirty;
  const saveable =
    dirty && trimmedName !== "" && trimmedPrompt !== "" && save.kind !== "busy";

  async function onSave() {
    setSave({ kind: "busy" });
    try {
      if (instructionsDirty) {
        await updateAgentInstructions(tenantId, definition.id, {
          name: trimmedName,
          systemPrompt: trimmedPrompt,
        });
      }
      if (modelDirty) {
        await setAgentModel(tenantId, definition.id, model);
      }
      if (skillsDirty) {
        await updateAgentSkills(tenantId, definition.id, [...skills]);
      }
      setSave({ kind: "idle" });
      onSaved();
    } catch (cause: unknown) {
      setSave({
        kind: "error",
        message: describeApiError(cause, "saving this agent"),
      });
    }
  }

  async function onDuplicate() {
    setLifecycle({ kind: "busy" });
    try {
      const handle = duplicateHandle(definition.name);
      await createAgentDefinition(tenantId, {
        name: `${detail.name} copy`,
        handle,
        systemPrompt: detail.systemPrompt,
        ...(detail.model !== undefined ? { model: detail.model } : {}),
        skills: [...detail.skills],
      });
      setLifecycle({ kind: "idle" });
      onDuplicated(handle);
    } catch (cause: unknown) {
      setLifecycle({
        kind: "error",
        message: describeApiError(cause, "duplicating this agent"),
      });
    }
  }

  async function onToggleArchived() {
    setLifecycle({ kind: "busy" });
    try {
      await setAgentDefinitionStatus(
        tenantId,
        definition.id,
        archived ? "deployed" : "stopped",
      );
      setLifecycle({ kind: "idle" });
      onStatusChanged();
    } catch (cause: unknown) {
      setLifecycle({
        kind: "error",
        message: describeApiError(
          cause,
          archived ? "restoring this agent" : "archiving this agent",
        ),
      });
    }
  }

  const recent = recentRunsForDefinition(runs, definition.id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Agents", href: AGENTS_PATH_PREFIX },
          { label: detail.name },
        ]}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={lifecycle.kind === "busy"}
              onClick={() => void onDuplicate()}
              aria-label="Duplicate this agent"
            >
              <Copy /> Duplicate
            </Button>
            <ConfirmButton
              size="sm"
              variant="outline"
              disabled={lifecycle.kind === "busy"}
              onConfirm={() => void onToggleArchived()}
              aria-label={
                archived ? "Restore this agent" : "Archive this agent"
              }
            >
              {archived ? "Restore" : "Archive"}
            </ConfirmButton>
            <Button
              size="sm"
              disabled={!saveable}
              onClick={() => void onSave()}
              aria-label="Save this agent"
            >
              {save.kind === "busy" ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageShell width="full" className="page-fill">
          <div className="flex flex-col gap-6 px-4 pb-8 sm:px-7">
            {save.kind === "error" ? (
              <p className="text-sm text-danger-foreground" role="alert">
                {save.message}
              </p>
            ) : null}
            {lifecycle.kind === "error" ? (
              <p className="text-sm text-danger-foreground" role="alert">
                {lifecycle.message}
              </p>
            ) : null}

            <Card className="flex flex-col gap-4 p-4">
              <div className="flex flex-col gap-2">
                <label
                  className="text-xs font-semibold uppercase text-muted-foreground"
                  htmlFor="agent-display-name"
                >
                  Display name
                </label>
                <input
                  id="agent-display-name"
                  className="w-full max-w-md border border-input bg-background px-3 py-2 text-sm"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <p className="font-mono text-xs text-muted-foreground">
                  {definition.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  The handle above is this agent&apos;s address and its URL. It
                  never changes.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[archived ? "stopped" : "deployed"]}>
                  {archived ? "Archived" : "Active"}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  {archived
                    ? "Archived — nobody can start a new chat with it until it is restored."
                    : "Active — anyone in this bench can start a chat with it."}
                </span>
              </div>
              <div className="flex flex-col gap-2">
                <label
                  className="text-xs font-semibold uppercase text-muted-foreground"
                  htmlFor="agent-model"
                >
                  Default model
                </label>
                {models.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No models in this bench&apos;s catalog yet — connect a
                    provider in Settings and this agent can pick one.
                  </p>
                ) : (
                  <Select
                    id="agent-model"
                    className="max-w-md"
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  >
                    <option value="">Bench default</option>
                    {models.map((catalogModel) => (
                      <option
                        key={catalogModel.canonicalName}
                        value={catalogModel.canonicalName}
                      >
                        {catalogModel.displayName ?? catalogModel.canonicalName}
                      </option>
                    ))}
                  </Select>
                )}
              </div>
            </Card>

            <Section
              title="System prompt"
              description="The instructions this agent follows on every turn."
            >
              <Textarea
                id="agent-system-prompt"
                aria-label="System prompt"
                className="min-h-80 font-mono text-sm"
                value={systemPrompt}
                onChange={(event) => setSystemPrompt(event.target.value)}
              />
            </Section>

            <Section
              title="Skills"
              description="Pinned skills this agent can load while it works."
            >
              <AgentSkillsPicker
                tenantId={tenantId}
                selected={[...skills]}
                onChange={(next) => setSkills(next)}
                idPrefix="agent-detail"
              />
            </Section>

            <Section
              title="Recent runs"
              description="Every run this agent has produced, newest first."
            >
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No runs yet — start a chat with this agent and its runs appear
                  here.
                </p>
              ) : (
                <Table aria-label="Recent runs">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Started</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recent.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="font-mono text-xs">
                          <Link
                            to={runDetailPath(run.id)}
                            className="underline underline-offset-2"
                          >
                            {run.id}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <Badge tone={RUN_STATUS_TONE[run.status]}>
                            {run.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {run.createdAt}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </Section>
          </div>
        </PageShell>
      </div>
    </div>
  );
}

type DetailLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly detail: AgentDefinitionDetail }
  | { readonly kind: "error"; readonly message: string };

/**
 * Resolves `/agents/<slug>` against the bench's own directory: the slug is
 * a definition's immutable `name`, so the row is found by name and its
 * authored state is then read from the definition route. A slug this bench
 * has no definition for is a real dead end, said plainly — never a blank
 * editor that would save into nothing.
 *
 * The editor is keyed on the reload counter so a save re-seeds its fields
 * from what the server now holds, rather than keeping local state that only
 * looks saved.
 */
export function AgentDetailRoute({
  slug,
  navigate,
}: {
  readonly slug: string;
  readonly navigate: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const queryClient = useQueryClient();
  const directory = useAgentDirectory(selectedTenantId ?? undefined);
  const [load, setLoad] = useState<DetailLoad>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const definition =
    directory.kind === "ready"
      ? (purposeAgentDefinitions(directory.data.definitions).find(
          (candidate) => candidate.name === slug,
        ) ?? null)
      : null;
  const definitionId = definition?.id ?? null;

  useEffect(() => {
    if (selectedTenantId === null || definitionId === null) return;
    let cancelled = false;
    setLoad({ kind: "loading" });
    getAgentDefinitionDetail(selectedTenantId, definitionId)
      .then((detail) => {
        if (!cancelled) setLoad({ kind: "ready", detail });
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setLoad({
            kind: "error",
            message: describeApiError(cause, "loading this agent"),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, definitionId, reloadKey]);

  function shell(body: ReactNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={[
            { label: "Agents", href: AGENTS_PATH_PREFIX },
            { label: slug },
          ]}
        />
        <PageShell width="full" className="page-fill">
          {body}
        </PageShell>
      </div>
    );
  }

  function refreshDirectory() {
    if (selectedTenantId === null) return;
    void queryClient.invalidateQueries({
      queryKey: tenantKeys.agentDirectory(selectedTenantId),
    });
  }

  if (selectedTenantId === null) {
    return shell(
      <RichEmptyState
        icon={<Robot />}
        title="Select a workbench"
        description="Pick a workbench from the switcher to open its agents."
      />,
    );
  }

  if (directory.kind !== "ready") {
    return shell(
      <QueryView query={directory} label="this agent" skeleton="rows">
        {() => null}
      </QueryView>,
    );
  }

  if (definition === null) {
    return shell(
      <RichEmptyState
        icon={<Robot />}
        title="No such agent"
        description={`Nothing in this bench answers to "${slug}". It may have been renamed, archived, or belong to another workbench.`}
        footer={
          <Button asChild variant="outline">
            <Link to={AGENTS_PATH_PREFIX}>Back to Agents</Link>
          </Button>
        }
      />,
    );
  }

  if (load.kind === "loading") {
    return shell(<p className="text-sm text-muted-foreground">Loading…</p>);
  }

  if (load.kind === "error") {
    return shell(
      <p className="text-sm text-danger-foreground" role="alert">
        {load.message}
      </p>,
    );
  }

  return (
    <AgentDetailPage
      key={`${definition.id}-${String(reloadKey)}`}
      tenantId={selectedTenantId}
      definition={definition}
      detail={load.detail}
      models={directory.data.models}
      runs={directory.data.instances}
      onSaved={() => {
        setReloadKey((key) => key + 1);
        refreshDirectory();
      }}
      onDuplicated={(handle) => {
        refreshDirectory();
        navigate(`${AGENTS_PATH_PREFIX}/${encodeURIComponent(handle)}`);
      }}
      onStatusChanged={refreshDirectory}
    />
  );
}
