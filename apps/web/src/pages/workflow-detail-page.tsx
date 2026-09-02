// `/workflows/<definitionAssetId>` (CL-7371) — a workflow definition's own
// page: what it is, whether it can run right now, its steps in execution
// order, and its access surface. Read-only, first useful version: header
// (name, lifecycle, source commit), steps, declared-vs-approved grants and
// credential binding names, and a "why not launchable" strip when the
// lifecycle isn't `deployed`.
//
// Never renders a credential value — only the binding names the hub
// route already redacted to (`@corbits/workflow-catalog`'s
// `detail-route.ts`) — and never reads `workflow.json` (see
// docs/workflow-model.md's retirement).
import {
  Badge,
  EmptyState,
  PageShell,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Clock, FlowArrow } from "@corbits/icons";

import { useBench } from "../bench-context";
import {
  WORKFLOWS_PATH_PREFIX,
  workflowDefinitionAssetIdFromPath,
} from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import { tenantKeys } from "../query-client";
import { useTenantQuery } from "../routines-api";
import {
  getWorkflowDefinitionDetail,
  workflowNotLaunchableReason,
  type WorkflowDefinitionDetailT,
} from "../workflow-detail-api";

const LIFECYCLE_LABEL: Readonly<
  Record<WorkflowDefinitionDetailT["lifecycle"], string>
> = {
  "source-only": "Source only",
  "pending-approval": "Pending approval",
  deployed: "Deployed",
  superseded: "Superseded",
  "build-failed": "Build failed",
};

const LIFECYCLE_TONE: Readonly<
  Record<WorkflowDefinitionDetailT["lifecycle"], BadgeTone>
> = {
  "source-only": "neutral",
  "pending-approval": "warning",
  deployed: "success",
  superseded: "neutral",
  "build-failed": "danger",
};

function shortSha(sha: string): string {
  return sha.length > 0 ? sha.slice(0, 7) : "";
}

/** The header row: display name, lifecycle badge, and (when known) the
 * source commit that produced the current definition. */
function WorkflowDetailHeader({
  detail,
}: {
  readonly detail: WorkflowDefinitionDetailT;
}) {
  const sha =
    detail.source !== undefined && detail.source !== null
      ? shortSha(detail.source.commitSha)
      : "";
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge tone={LIFECYCLE_TONE[detail.lifecycle]}>
          {LIFECYCLE_LABEL[detail.lifecycle]}
        </Badge>
        {sha !== "" ? (
          <span className="font-mono text-xs text-[var(--ui-fg-muted)]">
            {sha}
          </span>
        ) : null}
      </div>
      {detail.description !== undefined && detail.description !== null ? (
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">
          {detail.description}
        </p>
      ) : null}
    </section>
  );
}

/** Why this definition can't be launched right now, and the honest next
 * action — absent entirely once it is `deployed`, never a strip with
 * nothing true to say. */
export function NotLaunchableStrip({
  lifecycle,
}: {
  readonly lifecycle: WorkflowDefinitionDetailT["lifecycle"];
}) {
  const reason = workflowNotLaunchableReason(lifecycle);
  if (reason === null) return null;
  return (
    <div className="rounded-md border border-[var(--ui-border)] bg-[var(--ui-bg-muted)] px-4 py-3 text-sm">
      {reason}
    </div>
  );
}

/** Every step in execution order, with its role, model, director, tool
 * pins, and the grants the deploy-time capability walk froze onto it. */
export function WorkflowStepsSection({
  steps,
}: {
  readonly steps: WorkflowDefinitionDetailT["steps"];
}) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-[var(--ui-fg-muted)]">
        Steps
      </h2>
      {steps.length === 0 ? (
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">
          No approved steps yet — this workflow has not been deployed.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Step</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Director</TableHead>
              <TableHead>Model</TableHead>
              <TableHead>Tools</TableHead>
              <TableHead>Grants</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step) => (
              <TableRow key={step.id}>
                <TableCell className="font-mono text-xs">{step.id}</TableCell>
                <TableCell>{step.role}</TableCell>
                <TableCell>{step.director ?? "—"}</TableCell>
                <TableCell>{step.model ?? "—"}</TableCell>
                <TableCell>
                  {step.toolPins.length === 0 ? "—" : step.toolPins.join(", ")}
                </TableCell>
                <TableCell>
                  {step.grants.length === 0 ? "—" : step.grants.join(", ")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** Declared (what the source asks for) vs. approved (what the last freeze
 * actually granted) — and the credential binding names a step can use.
 * Names only, never a resolved credential value. */
export function WorkflowAccessSection({
  detail,
}: {
  readonly detail: WorkflowDefinitionDetailT;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-sm font-semibold uppercase tracking-wide text-[var(--ui-fg-muted)]">
        Access
      </h2>
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-[var(--ui-fg-muted)]">
          Declared grants
        </span>
        <span className="text-sm">
          {detail.grants.declared.length === 0
            ? "None declared"
            : detail.grants.declared.join(", ")}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-[var(--ui-fg-muted)]">
          Approved grants
        </span>
        <span className="text-sm">
          {detail.grants.approved.length === 0
            ? "None approved yet"
            : detail.grants.approved.join(", ")}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-[var(--ui-fg-muted)]">
          Credential bindings
        </span>
        <span className="text-sm">
          {detail.credentialBindings.length === 0
            ? "None"
            : detail.credentialBindings.join(", ")}
        </span>
      </div>
    </section>
  );
}

/** The whole page body, given a resolved detail — pure, so the layout is
 * testable without a fetch or a router. */
export function WorkflowDetailPage({
  detail,
}: {
  readonly detail: WorkflowDefinitionDetailT;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[
          { label: "Workflows", href: WORKFLOWS_PATH_PREFIX },
          { label: detail.displayName },
        ]}
      />
      <PageShell width="full" className="page-fill">
        <div className="flex flex-col gap-6">
          <WorkflowDetailHeader detail={detail} />
          <NotLaunchableStrip lifecycle={detail.lifecycle} />
          <WorkflowStepsSection steps={detail.steps} />
          <WorkflowAccessSection detail={detail} />
        </div>
      </PageShell>
    </div>
  );
}

/** A workflow-shaped screen with nothing to show yet. */
function WorkflowNotice({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar crumbs={[{ label: title }]} />
      <PageShell width="full" className="page-fill">
        <EmptyState
          icon={<FlowArrow />}
          title={title}
          description={description}
        />
      </PageShell>
    </div>
  );
}

export function WorkflowDetailRoute({ path }: { readonly path: string }) {
  const { selectedTenantId } = useBench();
  const definitionAssetId = workflowDefinitionAssetIdFromPath(path);
  const tenantId = selectedTenantId ?? "";
  const enabled = definitionAssetId !== null && selectedTenantId !== null;

  const detailQuery = useTenantQuery(
    [...tenantKeys.definitions(tenantId), "detail", definitionAssetId ?? ""],
    enabled,
    () => getWorkflowDefinitionDetail(tenantId, definitionAssetId ?? ""),
  );

  if (definitionAssetId === null) {
    return (
      <WorkflowNotice
        title="No workflow at this address"
        description="The link points at a workflow this workbench can't read."
      />
    );
  }

  if (
    detailQuery.kind === "loading" ||
    detailQuery.kind === "unauthenticated"
  ) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar
          crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }]}
        />
        <PageShell width="full" className="page-fill">
          <EmptyState icon={<Clock />} title="Loading workflow…" />
        </PageShell>
      </div>
    );
  }

  if (detailQuery.kind === "error") {
    return (
      <WorkflowNotice title="Workflow" description={detailQuery.message} />
    );
  }

  return <WorkflowDetailPage detail={detailQuery.data} />;
}
