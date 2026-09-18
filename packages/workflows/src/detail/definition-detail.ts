// The wire shape a workflow's own page reads. Pure/browser-safe. Mirrors
// `@intx/hub-api`'s stock definitions list, which exposes only these fields.
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
