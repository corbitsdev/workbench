// A message's attachments, rendered under its body. A package an agent
// wrote gets a Deploy card — the person is the one who deploys, since an
// agent never calls the hub; anything else is a plain file list.

import { Button } from "@corbits/react-ui";

import { useDeployAgentMutation } from "../agents-api";
import { chatPath } from "../chat-path";
import { Link } from "../navigation";
import { deployablePackage, type DeployablePackage } from "./deployable-package";
import type { MailAttachment } from "./threads-api";

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MessageAttachments({
  tenantId,
  attachments,
}: {
  readonly tenantId: string;
  readonly attachments: readonly MailAttachment[];
}) {
  if (attachments.length === 0) return null;
  const pkg = deployablePackage(attachments);
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

function DeployPackageCard({
  tenantId,
  pkg,
}: {
  readonly tenantId: string;
  readonly pkg: DeployablePackage;
}) {
  const deploy = useDeployAgentMutation(tenantId);
  const deployed = deploy.data;
  return (
    <div className="chat-deploy-card">
      <div className="chat-deploy-card-text">
        <span className="chat-deploy-card-name">{pkg.name}</span>
        {pkg.description === undefined ? null : (
          <span className="chat-deploy-card-note">{pkg.description}</span>
        )}
      </div>
      {deployed === undefined ? (
        <Button
          variant="primary"
          size="sm"
          disabled={deploy.isPending}
          onClick={() => deploy.mutate({ name: pkg.name, systemPrompt: pkg.systemPrompt })}
        >
          {deploy.isPending ? "Deploying…" : `Deploy ${pkg.name}`}
        </Button>
      ) : (
        <Link to={chatPath(deployed.definitionAssetId)} className="chat-deploy-card-link">
          Open {pkg.name}
        </Link>
      )}
      {deploy.error === null ? null : (
        <p className="chat-deploy-card-error">{errorText(deploy.error)}</p>
      )}
    </div>
  );
}
