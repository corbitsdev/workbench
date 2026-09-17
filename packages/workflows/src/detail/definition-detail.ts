// The wire shape a workflow's own page (`apps/web/src/pages/
// workflow-detail-page.tsx`) reads. Pure/browser-safe: no `@intx/*`, no
// `drizzle-orm`, no `hono` — `@corbits/workflows/client` re-exports this
// directly so `apps/web` can import it.
//
// CL-8160: the Workbench-composed detail read (former `./detail-route.ts`,
// which joined `workflow_definition`/`workflow_definition_version`/`asset`
// through native freeze reads for steps, grants, credential bindings, a
// five-value lifecycle, and source commit info) is gone — the hub mounts
// no route of its own for this any more. The client now renders directly
// off `@intx/hub-api`'s stock `GET /api/tenants/:tenantId/workflows/
// definitions` list (`vendor/intx/hub-api/src/routes/workflow-definitions.ts`,
// `WorkflowDefinitionResponse` in `vendor/intx/types/src/workflows.ts`),
// which exposes only `id`, `name`, `description`, `currentVersion`,
// `status` (`deployed` | `stopped`), `createdAt`, `updatedAt` — no asset
// display name, no manifest/package metadata, no wire projection (so no
// steps, no schedule trigger), and no grant/credential-binding read. See
// `docs/CL-8160-upstream-ask.md`-equivalent PR note: this is a real gap,
// not a design choice made here.
import { type } from "arktype";

export const WorkflowDefinitionDetail = type({
  definitionId: "string",
  name: "string",
  "description?": "string | null",
  status: "'deployed' | 'stopped'",
  currentVersion: "string",
  createdAt: "string",
  updatedAt: "string",
});
export type WorkflowDefinitionDetail = typeof WorkflowDefinitionDetail.infer;

/** The next honest action for a definition that is not launchable right
 * now. `null` for `deployed`: nothing to say, the strip does not render.
 * Stock only distinguishes `deployed`/`stopped` — the richer
 * source-only/pending-approval/superseded/build-failed vocabulary the
 * native freeze read used to derive is gone with it. */
export function workflowNotLaunchableReason(
  status: WorkflowDefinitionDetail["status"],
): string | null {
  return status === "deployed"
    ? null
    : "This workflow is stopped — resume it to make it launchable.";
}

export function workflowDetailPath(definitionId: string): string {
  return `/workflows/${encodeURIComponent(definitionId)}`;
}
