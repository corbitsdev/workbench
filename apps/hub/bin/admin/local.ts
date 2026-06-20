/* eslint-disable no-console */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// "Local actions" — operator tasks the spec-driven HTTP menu can't express
// because they run locally rather than as a single hub request: bootstrap
// seeding, building/publishing tool packages, pushing a workflow. The admin CLI
// is the single operator entrypoint, so it drives these too (replacing the old
// per-task npm scripts) by spawning the kept bin/* scripts with the selected
// tenant threaded through as `--tenant <slug>`.

export interface LocalAction {
  label: string;
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
  // Bootstrap actions run before/independent of auth (e.g. first superadmin).
  bootstrap?: boolean;
}

export const LOCAL_ACTIONS: LocalAction[] = [
  { label: 'Seed superadmin (bootstrap)', script: 'seed.ts', bootstrap: true },
  { label: 'Seed tool credentials from env', script: 'seed-credentials.ts', tenantAware: true },
  { label: 'Add LLM credential', script: 'add-llm-credential.ts', tenantAware: true },
  { label: 'Build tool packages', script: 'build-tool-packages.ts' },
  {
    label: 'Publish tool packages',
    script: 'publish-tool-packages.ts',
    baseArgs: ['--from', 'dist/tool-packages'],
    tenantAware: true,
  },
  {
    label: 'Push a workflow',
    script: 'deploy-workflow.ts',
    tenantAware: true,
    prompt: { text: 'Workflow kind (e.g. pain-point-collateral)', flag: '--kind' },
  },
];

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

const BIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

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
