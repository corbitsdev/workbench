// `/workflows/<definitionId>` (CL-7371) — a workflow definition's own
// page. CL-8160: the hub-composed detail read (name, lifecycle, source
// commit, steps, declared-vs-approved grants, credential bindings) is
// gone with `@corbits/workflows`'s deleted `./detail/detail-route.ts` —
// stock's `GET /workflows/definitions` (`workflow-detail-api.ts`) exposes
// only name, description, status (`deployed` | `stopped`), current
// version, and timestamps. This renders exactly that; see the CL-8160 PR
// for the upstream ask to expose more (package manifest, wire projection,
// grant snapshot) through a stock route.
import { Badge, EmptyState, PageShell } from "@corbits/react-ui";
import type { BadgeTone } from "@corbits/react-ui";
import { Clock, FlowArrow } from "@corbits/icons";

import { useBench } from "../bench-context";
import { WORKFLOWS_PATH_PREFIX, workflowDefinitionAssetIdFromPath } from "../path-ids";
import { StageTopBar } from "../shell/stage-top-bar";
import { tenantKeys } from "../query-client";
import { useTenantQuery } from "../routines-api";
import {
  getWorkflowDefinitionDetail,
  workflowNotLaunchableReason,
  type WorkflowDefinitionDetailT,
} from "../workflow-detail-api";

const STATUS_LABEL: Readonly<Record<WorkflowDefinitionDetailT["status"], string>> = {
  deployed: "Deployed",
  stopped: "Stopped",
};

const STATUS_TONE: Readonly<Record<WorkflowDefinitionDetailT["status"], BadgeTone>> = {
  deployed: "success",
  stopped: "neutral",
};

/** The header row: display name, status badge, and current version. */
function WorkflowDetailHeader({ detail }: { readonly detail: WorkflowDefinitionDetailT }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Badge tone={STATUS_TONE[detail.status]}>{STATUS_LABEL[detail.status]}</Badge>
        <span className="font-mono text-xs text-[var(--ui-fg-muted)]">
          v{detail.currentVersion}
        </span>
      </div>
      {detail.description !== undefined && detail.description !== null ? (
        <p className="m-0 text-sm text-[var(--ui-fg-muted)]">{detail.description}</p>
      ) : null}
    </section>
  );
}

/** Why this definition can't be launched right now — absent entirely once
 * it is `deployed`, never a strip with nothing true to say. */
export function NotLaunchableStrip({
  status,
}: {
  readonly status: WorkflowDefinitionDetailT["status"];
}) {
  const reason = workflowNotLaunchableReason(status);
  if (reason === null) return null;
  return (
    <div className="rounded-md border border-[var(--ui-border)] bg-[var(--ui-bg-muted)] px-4 py-3 text-sm">
      {reason}
    </div>
  );
}

/** The whole page body, given a resolved detail — pure, so the layout is
 * testable without a fetch or a router. */
export function WorkflowDetailPage({ detail }: { readonly detail: WorkflowDefinitionDetailT }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <StageTopBar
        crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }, { label: detail.name }]}
      />
      <PageShell width="full" className="page-fill">
        <div className="flex flex-col gap-6">
          <WorkflowDetailHeader detail={detail} />
          <NotLaunchableStrip status={detail.status} />
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
        <EmptyState icon={<FlowArrow />} title={title} description={description} />
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

  if (detailQuery.kind === "loading" || detailQuery.kind === "unauthenticated") {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StageTopBar crumbs={[{ label: "Workflows", href: WORKFLOWS_PATH_PREFIX }]} />
        <PageShell width="full" className="page-fill">
          <EmptyState icon={<Clock />} title="Loading workflow…" />
        </PageShell>
      </div>
    );
  }

  if (detailQuery.kind === "error") {
    return <WorkflowNotice title="Workflow" description={detailQuery.message} />;
  }

  return <WorkflowDetailPage detail={detailQuery.data} />;
}
