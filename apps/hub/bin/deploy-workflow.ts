// Push a native @intx/workflow definition to a running hub for deployment.
// The script imports the workflow's own package (@workbench/workflow-<kind>),
// serializes its exported `workflow` definition, and POSTs it to the operator-
// gated hub deploy route. The hub imports no workflow code. See
// docs/DEPLOYING_WORKFLOWS.md.

import { parseArgs } from 'node:util';
import { type, type Type } from 'arktype';

const DeployResult = type({ kind: "'multi-step'", publicKey: 'string' }).or({
  kind: "'trivial'",
});
const DeployResponse = type({
  kind: 'string',
  deploymentId: 'string',
  result: DeployResult,
});

export type DeployWorkflowOptions = {
  hubURL: string;
  kind: string;
  serviceToken: string;
};

function parseSchema<T extends Type>(schema: T, data: unknown, label: string): T['infer'] {
  const result = schema(data);
  if (result instanceof type.errors) {
    throw new Error(`deploy-workflow: validation failed for ${label}: ${result.summary}`);
  }
  return result;
}

// Inline tool factories (functions) silently vanish through JSON.stringify, so a
// workflow that declares tools as factories rather than serializable capability
// refs would deploy tool-less agents. Refuse such definitions up front.
function assertSerializable(value: unknown, seen: Set<object>, path: string): void {
  if (typeof value === 'function') {
    throw new Error(
      `deploy-workflow: definition is not serializable at ${path} (a function — express tools via capability/director refs, not inline factories)`
    );
  }
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertSerializable(child, seen, `${path}.${key}`);
  }
}

async function loadWorkflowDefinition(kind: string): Promise<unknown> {
  const mod: unknown = await import(`@workbench/workflow-${kind}`);
  if (typeof mod !== 'object' || mod === null || !('workflow' in mod)) {
    throw new Error(`deploy-workflow: @workbench/workflow-${kind} does not export "workflow"`);
  }
  const definition = (mod as { workflow: unknown }).workflow;
  assertSerializable(definition, new Set(), 'workflow');
  return definition;
}

export async function deployWorkflow(opts: DeployWorkflowOptions): Promise<void> {
  const definition = await loadWorkflowDefinition(opts.kind);
  const res = await fetch(`${opts.hubURL}/api/internal/workflows/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.serviceToken}`,
    },
    body: JSON.stringify(definition),
  });
  if (res.status !== 200) {
    throw new Error(`deploy-workflow: deploy failed (${String(res.status)}): ${await res.text()}`);
  }
  const parsed = parseSchema(DeployResponse, await res.json(), 'deploy response');
  process.stdout.write(
    `Deployed ${parsed.kind} (deployment ${parsed.deploymentId}, ${parsed.result.kind})\n`
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`deploy-workflow: ${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { kind: { type: 'string' }, 'hub-url': { type: 'string' } },
    strict: true,
  });
  if (values.kind === undefined) {
    throw new Error('deploy-workflow: --kind <workflow-kind> is required');
  }
  await deployWorkflow({
    hubURL: values['hub-url'] ?? requireEnv('HUB_URL'),
    kind: values.kind,
    serviceToken: requireEnv('HUB_SERVICE_TOKEN'),
  });
}

if (import.meta.main) {
  await main();
}
