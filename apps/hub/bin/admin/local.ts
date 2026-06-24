/* eslint-disable no-console */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TEMPLATES } from '@workbench/agents';

// "Local actions" — operator tasks the spec-driven HTTP menu can't express
// because they run locally rather than as a single hub request: bootstrap
// seeding, building/publishing tool packages, pushing a workflow. The admin CLI
// is the single operator entrypoint, so it drives these too (replacing the old
// per-task npm scripts) by spawning the kept bin/* scripts with the selected
// tenant threaded through as `--tenant <slug>`.

export interface LocalAction {
  label: string;
  // The resource group this action appears under in the top-level menu, so
  // workflows aren't buried inside a generic build/seed grab-bag.
  group: string;
  // Script filename under apps/hub/bin/.
  script: string;
  // Fixed leading args.
  baseArgs?: string[];
  // Append `--tenant <slug>` so the CLI's tenant choice drives the action.
  tenantAware?: boolean;
  // When set, prompt the operator for a single value and pass it as
  // `<flag> <value>` — so the CLI stays the interface and the operator never
  // types raw script flags.
  prompt?: { text: string; flag: string };
  // When set, present a discovered list of values to pick from (instead of a
  // free-text prompt) and pass the choice as `<flag> <value>`. This is how the
  // operator picks a workflow without knowing its kind by heart.
  choices?: { text: string; flag: string; discover: () => string[] };
  // Bootstrap actions run before/independent of auth (e.g. first superadmin).
  bootstrap?: boolean;
}

const BIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = dirname(dirname(dirname(BIN_DIR)));

export const SETUP_GROUP = 'Local actions (build, seed)';
export const WORKFLOWS_GROUP = 'Workflows';

export const LOCAL_ACTIONS: LocalAction[] = [
  {
    label: 'Seed superadmin (bootstrap)',
    group: SETUP_GROUP,
    script: 'seed.ts',
    bootstrap: true,
  },
  {
    label: 'Seed tool credentials from env',
    group: SETUP_GROUP,
    script: 'seed-credentials.ts',
    tenantAware: true,
  },
  {
    label: 'Seed model catalog (providers, models, offerings)',
    group: SETUP_GROUP,
    script: 'seed-catalog.ts',
    tenantAware: true,
  },
  {
    label: 'Add LLM credential',
    group: SETUP_GROUP,
    script: 'add-llm-credential.ts',
    tenantAware: true,
  },
  {
    label: 'Delete agent instances in bulk (cleanup)',
    group: SETUP_GROUP,
    script: 'cleanup-instances.ts',
    tenantAware: true,
  },
  {
    label: 'Backfill supervisor session IDs (analytics)',
    group: SETUP_GROUP,
    script: 'backfill-analytics-sessions.ts',
    tenantAware: true,
    baseArgs: ['--yes'],
  },
  {
    label: 'Build tool packages',
    group: SETUP_GROUP,
    script: 'build-tool-packages.ts',
  },
  {
    label: 'Publish tool packages',
    group: SETUP_GROUP,
    script: 'publish-tool-packages.ts',
    get baseArgs() {
      return ['--from', join(REPO_ROOT, 'dist/tool-packages')];
    },
    tenantAware: true,
  },
  {
    label: 'Push (deploy) a workflow',
    group: WORKFLOWS_GROUP,
    script: 'deploy-workflow.ts',
    tenantAware: true,
    choices: {
      text: 'Workflow',
      flag: '--kind',
      discover: discoverWorkflowKinds,
    },
  },
  {
    label: 'Deploy an agent definition',
    group: WORKFLOWS_GROUP,
    script: 'deploy-agent.ts',
    tenantAware: true,
    choices: {
      text: 'Agent template',
      flag: '--template',
      discover: discoverAgentTemplates,
    },
  },
  {
    label: 'Purge all credentials + providers from a tenant',
    group: SETUP_GROUP,
    script: 'purge-credentials.ts',
    tenantAware: true,
  },
  {
    label: 'Delete a tenant (IRREVERSIBLE — requires DATABASE_URL)',
    group: SETUP_GROUP,
    script: 'delete-tenant.ts',
    tenantAware: true,
  },
];

export interface LocalGroup {
  group: string;
  actions: LocalAction[];
}

// Local actions split into their resource groups, preserving declaration order
// within each group and the order groups first appear. Drives the top-level
// resource menu so workflows surface as their own resource.
export function localGroups(): LocalGroup[] {
  const order: string[] = [];
  const byGroup = new Map<string, LocalAction[]>();
  for (const action of LOCAL_ACTIONS) {
    const list = byGroup.get(action.group);
    if (list) {
      list.push(action);
    } else {
      order.push(action.group);
      byGroup.set(action.group, [action]);
    }
  }
  return order.map((group) => ({ group, actions: byGroup.get(group) ?? [] }));
}

// The kind authored into `@workbench/workflow-<kind>`. Returns null for any
// package name that isn't a workflow package so non-workflow members are
// ignored.
export function workflowKindFromPackageName(name: unknown): string | null {
  const prefix = '@workbench/workflow-';
  if (typeof name !== 'string' || !name.startsWith(prefix)) return null;
  const kind = name.slice(prefix.length);
  return kind === '' ? null : kind;
}

// Discover every workflow kind that can be pushed by reading the repo's
// `workflows/<kind>/package.json` members. The push script loads
// `workflows/<kind>` by path, so this list is exactly what the operator can
// deploy — no hard-coded kinds to drift out of date.
export function discoverWorkflowKinds(): string[] {
  const repoRoot = dirname(dirname(dirname(BIN_DIR)));
  const workflowsDir = join(repoRoot, 'workflows');
  if (!existsSync(workflowsDir)) return [];
  const kinds: string[] = [];
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(workflowsDir, entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        name?: unknown;
      };
      const kind = workflowKindFromPackageName(pkg.name);
      if (kind !== null) kinds.push(kind);
    } catch {
      continue;
    }
  }
  return kinds.sort((a, b) => a.localeCompare(b));
}

export function discoverAgentTemplates(): string[] {
  return AGENT_TEMPLATES.map((t) => t.key).sort((a, b) => a.localeCompare(b));
}

// Build the argv to spawn for a local action. Pure so it can be unit-tested
// without spawning. `binDir` is apps/hub/bin; extraArgs are operator-supplied.
export function buildLocalCommand(
  action: LocalAction,
  binDir: string,
  tenantSlug: string,
  extraArgs: string[]
): string[] {
  const argv = ['run', join(binDir, action.script)];
  if (action.baseArgs) argv.push(...action.baseArgs);
  argv.push(...extraArgs);
  if (action.tenantAware) argv.push('--tenant', tenantSlug);
  return argv;
}

export async function runLocalAction(
  action: LocalAction,
  tenantSlug: string,
  extraArgs: string[]
): Promise<number> {
  const argv = buildLocalCommand(action, BIN_DIR, tenantSlug, extraArgs);
  console.log(`\n$ bun ${argv.join(' ')}\n`);
  return new Promise<number>((resolve) => {
    const child = spawn('bun', argv, { stdio: 'inherit', env: process.env });
    child.on('close', (code) => resolve(code ?? 0));
  });
}
