// A message's attachments, rendered under its body. A package an agent
// wrote gets a Deploy card — the person is the one who deploys, since an
// agent never calls the hub; anything else is a plain file list.

import { Button } from "@corbits/react-ui";
import { cronSentence } from "@corbits/workflows/client";

import { WarningCircle } from "@/lib/icons";

import { useDeployAgentMutation } from "../agents-api";
import { useMcpServers } from "../tools/mcp-servers-query";
import {
  isFiveFieldCron,
  isPackageRejection,
  type DeployablePackage,
  type PackageOutcome,
} from "./deployable-package";
import type { MailAttachment } from "./threads-api";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MessageAttachments({
  tenantId,
  attachments,
  pkg,
}: {
  readonly tenantId: string;
  readonly attachments: readonly MailAttachment[];
  /** Resolved by the caller via `resolveMessagePackage` — attachments and
   * body-carried fenced blocks both land here. */
  readonly pkg: PackageOutcome;
}) {
  if (pkg === null && attachments.length === 0) return null;
  if (isPackageRejection(pkg)) return <PackageRejectionCard reason={pkg.reason} />;
  if (pkg === null) {
    return (
      <ul className="chat-attachment-list" aria-label="Attachments">
        {attachments.map((attachment) => (
          <li key={attachment.name}>
            <span className="chat-attachment-name">{attachment.name}</span>
            <span className="chat-attachment-type">{attachment.contentType}</span>
          </li>
        ))}
      </ul>
    );
  }
  return <DeployPackageCard tenantId={tenantId} pkg={pkg} />;
}

/** Same visual family as the Deploy card, but for a package attempt that
 * failed to parse — names the reason, offers no button. */
function PackageRejectionCard({ reason }: { readonly reason: string }) {
  return (
    <div className="chat-deploy-card chat-package-rejection-card">
      <div className="chat-deploy-card-text">
        <span className="chat-deploy-card-name">
          <WarningCircle className="chat-package-rejection-icon" aria-hidden="true" />
          Package couldn&apos;t deploy
        </span>
        <span className="chat-deploy-card-error">{reason}</span>
      </div>
    </div>
  );
}

function DeployPackageCard({
  tenantId,
  pkg,
}: {
  readonly tenantId: string;
  readonly pkg: DeployablePackage;
}) {
  const deploy = useDeployAgentMutation(tenantId);
  const deployed = deploy.data;
  const scheduleValid = pkg.schedule === undefined || isFiveFieldCron(pkg.schedule);
  const sentence = pkg.schedule !== undefined && scheduleValid ? cronSentence(pkg.schedule) : null;
  // Handles Myra named that are not in this workspace's catalog can never
  // bind — name them before deploy, where the failure would only read as a
  // rejected deploy. While the catalog is still loading there is nothing to
  // check against, so the card stays enabled and deploy fails closed.
  const catalog = useMcpServers(tenantId);
  const unknownHandles =
    catalog.kind === "ready" && pkg.mcpHandles !== undefined
      ? pkg.mcpHandles.filter((handle) => !catalog.data.some((server) => server.handle === handle))
      : [];
  return (
    <div className="chat-deploy-card">
      <div className="chat-deploy-card-text">
        <span className="chat-deploy-card-name">{pkg.name}</span>
        {pkg.description === undefined ? null : (
          <span className="chat-deploy-card-note">{pkg.description}</span>
        )}
        {sentence !== null ? <span className="chat-deploy-card-note">{sentence}</span> : null}
        {pkg.schedule !== undefined && !scheduleValid ? (
          <span className="chat-deploy-card-error">
            {`This package's schedule ("${pkg.schedule}") isn't a valid five-field cron string.`}
          </span>
        ) : null}
        {unknownHandles.length > 0 ? (
          <span className="chat-deploy-card-error">
            {`This package names MCP servers this workspace doesn't have: ${unknownHandles.join(", ")}. Ask Myra to use the Tools page handles.`}
          </span>
        ) : null}
      </div>
      {deployed === undefined ? (
        <Button
          variant="primary"
          size="sm"
          disabled={deploy.isPending || !scheduleValid || unknownHandles.length > 0}
          onClick={() =>
            deploy.mutate({
              name: pkg.name,
              systemPrompt: pkg.systemPrompt,
              ...(pkg.schedule !== undefined ? { schedule: pkg.schedule } : {}),
              ...(pkg.mcpHandles !== undefined ? { mcpHandles: pkg.mcpHandles } : {}),
            })
          }
        >
          {deploy.isPending ? "Deploying…" : `Deploy ${pkg.name}`}
        </Button>
      ) : (
        <span className="chat-deploy-card-note">{pkg.name} is deployed.</span>
      )}
      {deploy.error === null ? null : (
        <p className="chat-deploy-card-error">{errorText(deploy.error)}</p>
      )}
    </div>
  );
}
