// The agent's own page, addressed by its definition id — `/agents/<id>`.
// Everything here is stock read-only observability: the definition's own
// status, its live top-level run's address, health, event log, and
// approvals. There is no editor on this page — display name, system
// prompt, model, and skill pins were all authored through
// `@corbits/agent-directory` routes that no longer exist on the hub; a
// hand-authored agent's only lifecycle is deploy (`CreateAgentPanel`) and
// observe (this page).

import {
  Badge,
  PageShell,
  RichEmptyState,
  Section,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Robot } from "@/lib/icons";
import type { ReactNode } from "react";

import { QueryView } from "@/lib/api-query";

import type { AgentDefinition, AgentInstance } from "../agents-api";
import {
  useAgentDirectory,
  useAgentRunApprovals,
  useAgentRunEvents,
  useAgentRunHealth,
} from "../agents-api";
import type { AgentDefinitionWithDisplayName } from "../agents-directory";
import { withAgentDisplayName } from "../agents-directory";
import { useBench } from "../bench-context";
import { AGENTS_PATH_PREFIX } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";

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

const HEALTH_TONE: Record<"ok" | "unhealthy" | "not_ready", BadgeTone> = {
  ok: "success",
  unhealthy: "danger",
  not_ready: "neutral",
};

/** The message half of a non-ready `APIQuery` — "unauthenticated" carries
 * no message of its own, so it reads as a plain sign-in prompt instead. */
function queryFailureMessage(
  query:
    | { readonly kind: "unauthenticated" }
    | { readonly kind: "error"; readonly message: string },
): string {
  return query.kind === "unauthenticated" ? "You're signed out." : query.message;
}

function HealthRow({ tenantId, runId }: { readonly tenantId: string; readonly runId: string }) {
  const health = useAgentRunHealth(tenantId, runId);
  if (health.kind === "loading") return <Skeleton className="h-4 w-24" />;
  if (health.kind !== "ready") {
    return (
      <span className="text-sm text-destructive" role="alert">
        {queryFailureMessage(health)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={HEALTH_TONE[health.data.liveness]} className="normal-case">
        Liveness: {health.data.liveness}
      </Badge>
      <Badge tone={HEALTH_TONE[health.data.readiness]} className="normal-case">
        Readiness: {health.data.readiness}
      </Badge>
    </span>
  );
}

function EventsSection({ tenantId, runId }: { readonly tenantId: string; readonly runId: string }) {
  const events = useAgentRunEvents(tenantId, runId);
  if (events.kind === "loading") return <Skeleton className="h-24 w-full" />;
  if (events.kind !== "ready") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {queryFailureMessage(events)}
      </p>
    );
  }
  if (events.data.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  return (
    <Table aria-label="Run events">
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Seq</TableHead>
          <TableHead>Type</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.data.map((event) => (
          <TableRow key={event.seq}>
            <TableCell className="tabular-nums text-muted-foreground">{event.seq}</TableCell>
            <TableCell className="font-mono text-xs">{event.type}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ApprovalsSection({
  tenantId,
  runId,
}: {
  readonly tenantId: string;
  readonly runId: string;
}) {
  const approvals = useAgentRunApprovals(tenantId, runId);
  if (approvals.kind === "loading") return <Skeleton className="h-24 w-full" />;
  if (approvals.kind !== "ready") {
    return (
      <p className="text-sm text-destructive" role="alert">
        {queryFailureMessage(approvals)}
      </p>
    );
  }
  if (approvals.data.approvals.length === 0) {
    return <p className="text-sm text-muted-foreground">No approvals yet.</p>;
  }
  return (
    <Table aria-label="Run approvals">
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Scope</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {approvals.data.approvals.map((approval) => (
          <TableRow key={approval.id}>
            <TableCell className="font-mono text-xs">
              {typeof approval.toolDefinition.name === "string"
                ? approval.toolDefinition.name
                : approval.id}
            </TableCell>
            <TableCell>{approval.scope ?? "once"}</TableCell>
            <TableCell>{approval.status}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AgentDetailPage({
  tenantId,
  definition,
  run,
}: {
  readonly tenantId: string;
  readonly definition: AgentDefinitionWithDisplayName;
  /** This definition's own live top-level run, if it has been triggered
   * since deploy. `null` reads as "deployed, never yet run". */
  readonly run: AgentInstance | null;
}) {
  const archived = definition.status === "stopped";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Agents", href: AGENTS_PATH_PREFIX }, { label: definition.displayName }]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <PageShell width="full" className="page-fill">
          <div className="flex flex-col gap-6 px-4 pb-8 sm:px-7">
            <div className="flex flex-col gap-2">
              <p className="text-lg font-semibold">{definition.displayName}</p>
              <p className="font-mono text-xs text-muted-foreground">{definition.name}</p>
              <div className="flex items-center gap-2">
                <Badge tone={STATUS_TONE[archived ? "stopped" : "deployed"]}>
                  {archived ? "Archived" : "Active"}
                </Badge>
                {run !== null ? (
                  <Badge tone={RUN_STATUS_COPY[run.status].tone}>
                    {RUN_STATUS_COPY[run.status].label}
                  </Badge>
                ) : null}
              </div>
            </div>

            {run === null ? (
              <p className="text-sm text-muted-foreground">
                Deployed, but not yet run — send it a message to start its first run.
              </p>
            ) : (
              <>
                <Section title="Run" description="This agent's own live top-level run.">
                  <dl className="flex flex-col gap-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Address</dt>
                      <dd className="font-mono text-xs">{run.address}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt className="text-muted-foreground">Health</dt>
                      <dd>
                        <HealthRow tenantId={tenantId} runId={run.id} />
                      </dd>
                    </div>
                  </dl>
                </Section>

                <Section title="Events" description="This run's committed, seq-ordered event log.">
                  <EventsSection tenantId={tenantId} runId={run.id} />
                </Section>

                <Section
                  title="Approvals"
                  description="This run's approval decisions, newest first."
                >
                  <ApprovalsSection tenantId={tenantId} runId={run.id} />
                </Section>
              </>
            )}
          </div>
        </PageShell>
      </div>
    </div>
  );
}

/**
 * Resolves `/agents/<id>` from the bench's already-loaded agent directory —
 * there is no per-definition detail route on the hub anymore, so the
 * definition and its own top-level run both come from the same
 * `useAgentDirectory` query the roster keeps warm. `id` may be either the
 * definition's id or its immutable slug (`detailPath` prefers the slug when
 * it is a valid one).
 */
export function AgentDetailRoute({
  slug: id,
}: {
  readonly slug: string;
  /** Unused here — this page has no navigation of its own — kept so the
   * router's uniform `render(path, navigate)` call shape needs no
   * special case for this one route. */
  readonly navigate?: (to: string) => void;
}) {
  const { selectedTenantId } = useBench();
  const directory = useAgentDirectory(selectedTenantId ?? undefined);

  function shell(body: ReactNode) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Agents", href: AGENTS_PATH_PREFIX }, { label: id }]} />
        <PageShell width="full" className="page-fill">
          {body}
        </PageShell>
      </div>
    );
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

  const definition: AgentDefinition | undefined = directory.data.definitions.find(
    (candidate) => candidate.id === id || candidate.name === id,
  );

  if (definition === undefined) {
    return shell(
      <RichEmptyState
        icon={<Robot />}
        title="No such agent"
        description={`Nothing here answers to "${id}". It may have been renamed, or belong to another workbench.`}
      />,
    );
  }

  const run =
    directory.data.instances.find((instance) => instance.definitionId === definition.id) ?? null;

  return (
    <AgentDetailPage
      tenantId={selectedTenantId}
      definition={withAgentDisplayName(definition)}
      run={run}
    />
  );
}
