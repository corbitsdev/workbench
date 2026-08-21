// The agent's own page (CL-6414), addressed by its immutable slug —
// `/agents/<slug>`. Everything a person can author about an agent lives
// here: its display name, the model it resolves against, the system prompt
// it follows on every turn, the skills it has pinned, and the runs it has
// produced. The roster's quick-peek panel stays where it is; this is the
// full page a person lands on when quick-peek isn't enough (DESIGN.md,
// "Detail Pages").
//
// Every write goes through a mutation `@corbits/agent-directory` owns, via
// `../agents-api.ts` — this page invents no write path of its own:
//
//   display name + system prompt  PUT    /agent-definitions/:id
//   default model                 POST   /agent-definitions/:id/capabilities
//   clearing the model            DELETE /agent-definitions/:id/capabilities/model
//   pinned skills                 PUT    /agent-definitions/:id/skills
//   archive / restore             PUT    /agent-definitions/:id/status
//   duplicate                     POST   /agent-definitions
//
// One Save writes every dirty part and nothing else — an untouched field is
// never rewritten. Those parts are separate requests, so a Save can land
// partway: the page reports exactly which parts saved and which did not,
// and reloads either way, rather than claiming a clean failure over a
// half-applied change. Folding the three into one transactional route is
// the real fix and is deferred (see the PR).
//
// Two fields a person might expect are deliberately absent: the slug
// (immutable by design, so it renders as muted mono text rather than an
// input) and a separate description. A definition's row `description` IS
// its display name — that is where `deriveDisplayName` reads it from — and
// the purpose blurb inside the definition's own `workflow.json` has neither
// a read nor a write route today, so this page shows no description field
// rather than a control that silently edits the display name twice. Delete
// is likewise absent: archiving is the reversible lifecycle the platform
// actually backs, and tearing down a definition's asset and history has no
// route.

import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  Input,
  PageShell,
  RichEmptyState,
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

import { ApiQueryError, describeApiError, QueryView } from "@corbits/api-query";
import { slugify } from "@corbits/slug";

import type {
  AgentDefinition,
  AgentDefinitionDetail,
  AgentInstance,
  CatalogModel,
} from "../agents-api";
import {
  clearAgentModel,
  createAgentDefinition,
  getAgentDefinitionBySlug,
  getAgentDefinitionDetail,
  setAgentDefinitionStatus,
  setAgentModel,
  updateAgentInstructions,
  updateAgentSkills,
  useAgentDirectory,
} from "../agents-api";
import type { AgentDefinitionWithDisplayName } from "../agents-directory";
import { withAgentDisplayName } from "../agents-directory";
import { useBench } from "../bench-context";
import { runDetailPath } from "../insights-deeplinks";
import { Link } from "../navigation";
import { AGENTS_PATH_PREFIX } from "../path-ids";
import { tenantKeys } from "../query-client";
import { StageTopBar } from "../shell/stage-top-bar";
import { AgentSkillsPicker } from "./agent-skills-picker";

const STATUS_TONE: Record<"deployed" | "stopped", BadgeTone> = {
  deployed: "success",
  stopped: "neutral",
};

/** A run's state in the words a person uses for it, never the wire enum
 * (DESIGN.md, "Copy"). */
const RUN_STATUS_COPY: Record<
  AgentInstance["status"],
  { readonly label: string; readonly tone: BadgeTone }
> = {
  deployed: { label: "Ready", tone: "neutral" },
  running: { label: "Running now", tone: "success" },
  updating: { label: "Updating", tone: "warning" },
  error: { label: "Failed", tone: "danger" },
  stopped: { label: "Stopped", tone: "neutral" },
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
 * and surfaces that collision in words rather than guessing `-copy-2`. */
export function duplicateHandle(slug: string): string {
  return slugify(`${slug}-copy`);
}

/** The parts a Save writes, each its own request. */
export type SavePart = "instructions" | "model" | "skills";

const SAVE_PART_COPY: Record<SavePart, string> = {
  instructions: "name and system prompt",
  model: "default model",
  skills: "skills",
};

/**
 * What a Save actually did. `failed` names the first part that did not
 * land; `saved` names the parts that already committed before it, which is
 * the whole reason this is reported rather than a bare error — those writes
 * are real and the person needs to know they happened.
 */
export type SaveReport = {
  readonly saved: readonly SavePart[];
  readonly failed: { readonly part: SavePart; readonly message: string } | null;
};

/** The sentence a report reads as. */
export function describeSaveReport(report: SaveReport): string {
  const saved = report.saved.map((part) => SAVE_PART_COPY[part]).join(", ");
  if (report.failed === null) {
    return `Saved ${saved}.`;
  }
  const failed = `Couldn't save this agent's ${SAVE_PART_COPY[report.failed.part]}: ${report.failed.message}`;
  return report.saved.length === 0
    ? failed
    : `Saved ${saved} — then ${failed.slice(0, 1).toLowerCase()}${failed.slice(1)}`;
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
  saveReport,
  onSaved,
  onDuplicated,
  onStatusChanged,
}: {
  readonly tenantId: string;
  readonly definition: AgentDefinitionWithDisplayName;
  readonly detail: AgentDefinitionDetail;
  readonly models: readonly CatalogModel[];
  readonly runs: readonly AgentInstance[];
  /** The outcome of the Save that produced the state now on screen, held by
   * the route so it survives the reload a Save triggers. */
  readonly saveReport: SaveReport | null;
  readonly onSaved: (report: SaveReport) => void;
  readonly onDuplicated: (slug: string) => Promise<void>;
  readonly onStatusChanged: () => void;
}) {
  const [displayName, setDisplayName] = useState(definition.displayName);
  const [systemPrompt, setSystemPrompt] = useState(detail.systemPrompt);
  const [model, setModel] = useState(detail.model ?? "");
  const [skills, setSkills] = useState<readonly string[]>(detail.skills);
  const [save, setSave] = useState<WriteState>({ kind: "idle" });
  const [lifecycle, setLifecycle] = useState<WriteState>({ kind: "idle" });

  const archived = definition.status === "stopped";
  const trimmedName = displayName.trim();
  const trimmedPrompt = systemPrompt.trim();
  const instructionsDirty =
    trimmedName !== definition.displayName ||
    trimmedPrompt !== detail.systemPrompt;
  // Compared against the loaded value alone, so picking "Bench default" on
  // an agent with a pinned model is a real edit — clearing a model is a
  // change like any other, not the absence of one.
  const modelDirty = model !== (detail.model ?? "");
  const skillsDirty = !sameSkillSet(skills, detail.skills);
  const dirty = instructionsDirty || modelDirty || skillsDirty;
  const saveable =
    dirty && trimmedName !== "" && trimmedPrompt !== "" && save.kind !== "busy";

  async function onSave() {
    setSave({ kind: "busy" });
    const parts: readonly { part: SavePart; write: () => Promise<unknown> }[] =
      [
        ...(instructionsDirty
          ? [
              {
                part: "instructions" as const,
                write: () =>
                  updateAgentInstructions(tenantId, definition.id, {
                    name: trimmedName,
                    systemPrompt: trimmedPrompt,
                  }),
              },
            ]
          : []),
        ...(modelDirty
          ? [
              {
                part: "model" as const,
                write: () =>
                  model === ""
                    ? clearAgentModel(tenantId, definition.id)
                    : setAgentModel(tenantId, definition.id, model),
              },
            ]
          : []),
        ...(skillsDirty
          ? [
              {
                part: "skills" as const,
                write: () =>
                  updateAgentSkills(tenantId, definition.id, [...skills]),
              },
            ]
          : []),
      ];

    const saved: SavePart[] = [];
    for (const { part, write } of parts) {
      try {
        await write();
        saved.push(part);
      } catch (cause: unknown) {
        setSave({ kind: "idle" });
        // Reported, not thrown away: the parts already in `saved` are
        // committed on the server, so the page reloads to show them rather
        // than leaving a screen that disagrees with what was written.
        onSaved({
          saved,
          failed: {
            part,
            message: describeApiError(
              cause,
              `saving this agent's ${SAVE_PART_COPY[part]}`,
            ),
          },
        });
        return;
      }
    }
    setSave({ kind: "idle" });
    onSaved({ saved, failed: null });
  }

  async function onDuplicate() {
    setLifecycle({ kind: "busy" });
    const handle = duplicateHandle(definition.name);
    try {
      await createAgentDefinition(tenantId, {
        name: `${definition.displayName} copy`,
        handle,
        systemPrompt: detail.systemPrompt,
        ...(detail.model !== undefined ? { model: detail.model } : {}),
        skills: [...detail.skills],
      });
      await onDuplicated(handle);
      setLifecycle({ kind: "idle" });
    } catch (cause: unknown) {
      // A handle collision is the one failure retrying can never clear, so
      // it says what already exists instead of "try again".
      const conflict = cause instanceof ApiQueryError && cause.status === 409;
      setLifecycle({
        kind: "error",
        message: conflict
          ? `"${handle}" already exists — open that copy, or rename it, before duplicating this agent again.`
          : describeApiError(cause, "duplicating this agent"),
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
          { label: definition.displayName },
        ]}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={dirty || lifecycle.kind === "busy"}
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
            {saveReport !== null ? (
              <p
                className={
                  saveReport.failed === null
                    ? "text-sm text-muted-foreground"
                    : "text-sm text-danger-foreground"
                }
                role={saveReport.failed === null ? undefined : "alert"}
              >
                {describeSaveReport(saveReport)}
              </p>
            ) : null}
            {lifecycle.kind === "error" ? (
              <p className="text-sm text-danger-foreground" role="alert">
                {lifecycle.message}
              </p>
            ) : null}
            {dirty ? (
              <p className="text-sm text-muted-foreground">
                Unsaved edits — Duplicate copies the saved version, so it waits
                until you save.
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
                <Input
                  id="agent-display-name"
                  className="max-w-md"
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
                    ? "Archived — nobody can start a new conversation with it until it is restored. Conversations already running keep going."
                    : "Active — anyone in this workbench can talk to it."}
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
                          <Badge tone={RUN_STATUS_COPY[run.status].tone}>
                            {RUN_STATUS_COPY[run.status].label}
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
  | {
      readonly kind: "ready";
      readonly definition: AgentDefinition;
      readonly detail: AgentDefinitionDetail;
    }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "absent" };

/**
 * Resolves `/agents/<slug>` server-side: the slug is a definition's
 * immutable `name`, looked up by name (`getAgentDefinitionBySlug`) rather
 * than found in the directory listing, which is capped at one page — an
 * agent past that cap still answers on its own URL. Its authored state
 * comes from the definition route; models and runs come from the bench's
 * directory query, which the roster already keeps warm.
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
  const [saveReport, setSaveReport] = useState<SaveReport | null>(null);

  useEffect(() => {
    if (selectedTenantId === null) return;
    let cancelled = false;
    setLoad({ kind: "loading" });
    getAgentDefinitionBySlug(selectedTenantId, slug)
      .then(async (definition) => ({
        definition,
        detail: await getAgentDefinitionDetail(selectedTenantId, definition.id),
      }))
      .then(({ definition, detail }) => {
        if (!cancelled) setLoad({ kind: "ready", definition, detail });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (cause instanceof ApiQueryError && cause.status === 404) {
          setLoad({ kind: "absent" });
          return;
        }
        setLoad({
          kind: "error",
          message: describeApiError(cause, "loading this agent"),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTenantId, slug, reloadKey]);

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

  async function refreshDirectory() {
    if (selectedTenantId === null) return;
    await queryClient.invalidateQueries({
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

  if (load.kind === "absent") {
    return shell(
      <RichEmptyState
        icon={<Robot />}
        title="No such agent"
        description={`Nothing here answers to "${slug}". It may have been renamed, or belong to another workbench.`}
        footer={
          <Button asChild variant="outline">
            <Link to={AGENTS_PATH_PREFIX}>Back to Agents</Link>
          </Button>
        }
      />,
    );
  }

  if (load.kind === "error") {
    return shell(
      <p className="text-sm text-danger-foreground" role="alert">
        {load.message}
      </p>,
    );
  }

  if (load.kind === "loading") {
    return shell(<p className="text-sm text-muted-foreground">Loading…</p>);
  }

  // Models and runs ride on the bench's directory query; the agent itself
  // is already resolved, so a still-loading directory only delays those two
  // sections, never the page.
  if (directory.kind !== "ready") {
    return shell(
      <QueryView query={directory} label="this agent" skeleton="rows">
        {() => null}
      </QueryView>,
    );
  }

  return (
    <AgentDetailPage
      key={`${load.definition.id}-${String(reloadKey)}`}
      tenantId={selectedTenantId}
      definition={withAgentDisplayName(load.definition)}
      detail={load.detail}
      models={directory.data.models}
      runs={directory.data.instances}
      saveReport={saveReport}
      onSaved={(report) => {
        setSaveReport(report);
        setReloadKey((key) => key + 1);
        void refreshDirectory();
      }}
      onDuplicated={async (handle) => {
        await refreshDirectory();
        navigate(`${AGENTS_PATH_PREFIX}/${encodeURIComponent(handle)}`);
      }}
      onStatusChanged={() => {
        setReloadKey((key) => key + 1);
        void refreshDirectory();
      }}
    />
  );
}
