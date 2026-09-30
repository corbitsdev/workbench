// The one client-driven install path over stock routes: a `workflow`-kind
// asset, a short-lived git push token, the package's source pushed to
// `main`, then a deployment pinned to that commit. Identical files change
// nothing: `main` keeps its commit and the existing deployment is returned.
import { type } from "arktype";

import { pushSourceTree } from "./git-push";

export class InstallPackageError extends Error {}

const IdShape = type({ id: "string" });
const AssetListShape = type({ id: "string", name: "string" }).array();
const GitTokenShape = type({ id: "string", secret: "string" });
const DeploymentListShape = type({ id: "string", definitionAssetId: "string" }).array();
const ErrorEnvelope = type({ error: { "userMessage?": "string", "message?": "string" } });

const PUSH_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

export type InstallPackageArgs = {
  fetch: typeof fetch;
  /** Absolute origin the hub is served from; git remotes need absolute URLs. */
  origin: string;
  tenantId: string;
  assetName: string;
  displayName: string;
  /** The package's flat source tree, or a function of the asset id for a
   * package whose files name resources created against that asset. */
  files: Readonly<Record<string, string>> | ((assetId: string) => Promise<Record<string, string>>);
  entry: string;
  sourceOfferingIds: readonly string[];
  defaultSourceOfferingId: string;
};

async function readError(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined);
  const envelope = ErrorEnvelope(body);
  return envelope instanceof type.errors
    ? `HTTP ${response.status}`
    : (envelope.error.userMessage ?? envelope.error.message ?? `HTTP ${response.status}`);
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function ensureWorkflowAsset(args: InstallPackageArgs, base: string): Promise<string> {
  const created = await args.fetch(
    `${base}/assets`,
    json("POST", { kind: "workflow", name: args.assetName, displayName: args.displayName }),
  );
  if (created.status === 201) {
    const parsed = IdShape(await created.json());
    if (parsed instanceof type.errors) {
      throw new InstallPackageError(`the asset came back an unexpected shape: ${parsed.summary}`);
    }
    return parsed.id;
  }
  if (created.status !== 409) {
    throw new InstallPackageError(`creating the asset failed: ${await readError(created)}`);
  }
  const listed = await args.fetch(`${base}/assets?kind=workflow&inherited=false`);
  if (!listed.ok) {
    throw new InstallPackageError(`listing assets failed: ${await readError(listed)}`);
  }
  const parsed = AssetListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new InstallPackageError(
      `the asset list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  const existing = parsed.find((asset) => asset.name === args.assetName);
  if (existing === undefined) {
    throw new InstallPackageError(`asset ${args.assetName} conflicts but is not listed`);
  }
  return existing.id;
}

async function latestDeploymentId(
  args: InstallPackageArgs,
  base: string,
  assetId: string,
): Promise<string | null> {
  const listed = await args.fetch(`${base}/workflows/deployments`);
  if (!listed.ok) {
    throw new InstallPackageError(`listing deployments failed: ${await readError(listed)}`);
  }
  const parsed = DeploymentListShape(await listed.json());
  if (parsed instanceof type.errors) {
    throw new InstallPackageError(
      `the deployment list came back an unexpected shape: ${parsed.summary}`,
    );
  }
  // The route lists most recent first.
  return parsed.find((deployment) => deployment.definitionAssetId === assetId)?.id ?? null;
}

export async function installPackage(
  input: InstallPackageArgs,
): Promise<{ assetId: string; commitSha: string; deploymentId: string }> {
  // `window.fetch` throws "Illegal invocation" when called as a method of `args`.
  const args = { ...input, fetch: input.fetch.bind(globalThis) };
  const base = `${args.origin}/api/tenants/${encodeURIComponent(args.tenantId)}`;
  const assetId = await ensureWorkflowAsset(args, base);
  const files = typeof args.files === "function" ? await args.files(assetId) : args.files;

  const minted = await args.fetch(
    `${base}/git-tokens`,
    json("POST", {
      name: `install-${crypto.randomUUID()}`,
      resource: `asset:${assetId}`,
      refPattern: "refs/heads/main",
      actions: ["can_read", "can_push"],
      expiresAt: new Date(Date.now() + PUSH_TOKEN_LIFETIME_MS).toISOString(),
    }),
  );
  if (!minted.ok) {
    throw new InstallPackageError(`minting a push token failed: ${await readError(minted)}`);
  }
  const token = GitTokenShape(await minted.json());
  if (token instanceof type.errors) {
    throw new InstallPackageError(`the push token came back an unexpected shape: ${token.summary}`);
  }
  let pushed: { commitSha: string; changed: boolean };
  try {
    pushed = await pushSourceTree({
      fetch: args.fetch,
      url: `${base}/assets/workflow/${args.assetName}.git`,
      token: token.secret,
      tree: files,
      message: `Publish ${args.assetName}`,
    });
  } finally {
    await args.fetch(`${base}/git-tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
  }

  if (!pushed.changed) {
    const existing = await latestDeploymentId(args, base, assetId);
    if (existing !== null) {
      return { assetId, commitSha: pushed.commitSha, deploymentId: existing };
    }
  }

  const deployed = await args.fetch(
    `${base}/workflows/deployments`,
    json("POST", {
      source: {
        kind: "asset",
        assetId,
        package: { format: "source", commitSha: pushed.commitSha },
      },
      entry: args.entry,
      sourceOfferingIds: args.sourceOfferingIds,
      defaultSourceOfferingId: args.defaultSourceOfferingId,
    }),
  );
  if (!deployed.ok) {
    throw new InstallPackageError(
      `deploying ${args.assetName} failed: ${await readError(deployed)}`,
    );
  }
  const parsed = IdShape(await deployed.json());
  if (parsed instanceof type.errors) {
    throw new InstallPackageError(
      `the deployment came back an unexpected shape: ${parsed.summary}`,
    );
  }
  return { assetId, commitSha: pushed.commitSha, deploymentId: parsed.id };
}
