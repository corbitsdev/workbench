// Push a native @intx/workflow definition to a running hub for deployment.
// The script imports the workflow's own package (@workbench/workflow-<kind>),
// serializes its exported `workflow` definition, and POSTs it to the operator-
// gated hub deploy route. The hub imports no workflow code. See
// docs/DEPLOYING_WORKFLOWS.md.

import { parseArgs } from "node:util";
import { type, type Type } from "arktype";

const DeployResult = type({ kind: "'multi-step'", publicKey: "string" }).or({
  kind: "'trivial'",
});
const DeployResponse = type({
  kind: "string",
  deploymentId: "string",
  result: DeployResult,
});

// How the push authenticates to the hub. The operator path uses a better-auth
// SESSION_TOKEN (the same credential the admin CLI uses) against the
// session-authorized /api/v1 route, where the hub authorizes via the native
// grant check. The machine path uses the hub's service token (SIDECAR_TOKEN)
// against /api/internal — for unattended/sidecar callers with no session.
export type DeployAuth =
  | { mode: "session"; sessionToken: string }
  | { mode: "service"; serviceToken: string };

export type DeployWorkflowOptions = {
  hubURL: string;
  kind: string;
  auth: DeployAuth;
  // Optional target tenant slug. Omitted → the hub deploys to the global
  // tenant (unchanged). A slug scopes the deploy to that workbench sub-tenant,
  // which the hub validates is the global tenant or a descendant of it.
  tenantSlug?: string;
};

// Build the request URL + headers for the chosen auth mode. Session auth posts
// to the session-gated /api/v1 route with the better-auth cookie (both the
// dev and __Secure- names, matching the admin CLI's sign-in); service auth
// posts to /api/internal with a Bearer token.
export function buildDeployRequest(
  hubURL: string,
  query: string,
  auth: DeployAuth,
): { url: string; headers: Record<string, string> } {
  if (auth.mode === "session") {
    return {
      url: `${hubURL}/api/v1/workflows/deploy${query}`,
      headers: {
        "Content-Type": "application/json",
        Cookie: [
          `better-auth.session_token=${auth.sessionToken}`,
          `__Secure-better-auth.session_token=${auth.sessionToken}`,
        ].join("; "),
      },
    };
  }
  return {
    url: `${hubURL}/api/internal/workflows/deploy${query}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.serviceToken}`,
    },
  };
}

function parseSchema<T extends Type>(
  schema: T,
  data: unknown,
  label: string,
): T["infer"] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(
      `deploy-workflow: validation failed for ${label}: ${result.summary}`,
    );
  }
  return result;
}

// Inline tool factories (functions) silently vanish through JSON.stringify, so a
// workflow that declares tools as factories rather than serializable capability
// refs would deploy tool-less agents. Refuse such definitions up front.
function assertSerializable(
  value: unknown,
  seen: Set<object>,
  path: string,
): void {
  if (typeof value === "function") {
    throw new Error(
      `deploy-workflow: definition is not serializable at ${path} (a function — express tools via capability/director refs, not inline factories)`,
    );
  }
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertSerializable(child, seen, `${path}.${key}`);
  }
}

async function loadWorkflowDefinition(kind: string): Promise<unknown> {
  const mod: unknown = await import(`@workbench/workflow-${kind}`);
  if (typeof mod !== "object" || mod === null || !("workflow" in mod)) {
    throw new Error(
      `deploy-workflow: @workbench/workflow-${kind} does not export "workflow"`,
    );
  }
  const definition = (mod as { workflow: unknown }).workflow;
  assertSerializable(definition, new Set(), "workflow");
  return definition;
}

export async function deployWorkflow(
  opts: DeployWorkflowOptions,
): Promise<void> {
  const definition = await loadWorkflowDefinition(opts.kind);
  const query =
    opts.tenantSlug !== undefined && opts.tenantSlug !== ""
      ? `?tenant=${encodeURIComponent(opts.tenantSlug)}`
      : "";
  const { url, headers } = buildDeployRequest(opts.hubURL, query, opts.auth);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(definition),
  });
  if (res.status !== 200) {
    throw new Error(
      `deploy-workflow: deploy failed (${String(res.status)}): ${await res.text()}`,
    );
  }
  const parsed = parseSchema(
    DeployResponse,
    await res.json(),
    "deploy response",
  );
  process.stdout.write(
    `Deployed ${parsed.kind} (deployment ${parsed.deploymentId}, ${parsed.result.kind})\n`,
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(`deploy-workflow: ${name} is required`);
  return value;
}

// Resolve how to authenticate the push. Prefer the operator SESSION_TOKEN (the
// same credential the admin CLI uses) — the hub authorizes it via the native
// grant check, so an owner deploys workflows the same way it creates agents.
// Fall back to the service token (SIDECAR_TOKEN) for unattended/sidecar callers
// that have no session. HUB_SERVICE_TOKEN is accepted as a legacy alias.
export function resolveDeployAuth(envSource: NodeJS.ProcessEnv): DeployAuth {
  const sessionToken = envSource["SESSION_TOKEN"];
  if (sessionToken !== undefined && sessionToken !== "") {
    return { mode: "session", sessionToken };
  }
  const serviceToken =
    envSource["SIDECAR_TOKEN"] ?? envSource["HUB_SERVICE_TOKEN"];
  if (serviceToken !== undefined && serviceToken !== "") {
    return { mode: "service", serviceToken };
  }
  throw new Error(
    "deploy-workflow: no credential found — set SESSION_TOKEN (operator) or SIDECAR_TOKEN (service) in your env file",
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      kind: { type: "string" },
      "hub-url": { type: "string" },
      tenant: { type: "string" },
    },
    strict: true,
  });
  if (values.kind === undefined) {
    throw new Error("deploy-workflow: --kind <workflow-kind> is required");
  }
  await deployWorkflow({
    hubURL: values["hub-url"] ?? requireEnv("HUB_URL"),
    kind: values.kind,
    auth: resolveDeployAuth(process.env),
    tenantSlug: values.tenant ?? process.env["WORKBENCH_SLUG"],
  });
}

if (import.meta.main) {
  await main();
}
