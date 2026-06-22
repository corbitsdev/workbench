import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveDeployment } from '@workbench/tool-credentials';
import { sanitizeAgentAddress } from './workflow-host-wiring';
import { reconcileOrphanedDeploymentDirs } from './boot-reconciler';

const DOMAIN = 'abklabs.com';
const DOMAIN_SLUG = 'abklabs-com';

// Canonical deployment ids: `ses_` + 32 lowercase hex chars (the shape
// `generateId("session")` mints). The token-based reconciler only matches
// this shape, so tests must use realistic ids rather than `ses_live`.
const LIVE_ID = 'ses_00112233445566778899aabbccddeeff';
const DEAD_ID = 'ses_ffeeddccbbaa99887766554433221100';

function liveDeployment(deploymentId: string, stepIds: string[]): LiveDeployment {
  return {
    deploymentId,
    supervisorAddress: `ins_${deploymentId}@${DOMAIN}`,
    supervisorAgentId: `ins_${deploymentId}`,
    workflowRunSlug: `ins_${deploymentId}-${DOMAIN_SLUG}`,
    stepAgentIds: stepIds.map((s) => `ins_${deploymentId}-${s}`),
    stepAddresses: stepIds.map((s) => `ins_${deploymentId}-${s}@${DOMAIN}`),
    agentStateRepoIds: stepIds.map((s) => `${deploymentId}-${s}`),
  };
}

// Lay down EVERY on-disk dir-name form a real deployment produces, across
// all subsystems, so a test can prove none of a live deployment's forms is
// deleted and all of a dead deployment's forms are. The forms are keyed by
// THREE different id shapes for the same deployment:
//   - `agents/<deploymentId>-<step>`            (agent-state repo, raw id)
//   - `agents/<sanitizeAddress(stepAddress)>`   (session-manager-keyed agent
//                                                dir that can land under
//                                                agents/ — the keying bug)
//   - `<dataDir>/<sanitizeAddress(supervisor|step address)>` (top-level
//                                                ins_ agent dirs)
//   - `workflow-runs/<slug>`                    (workflow-run repo)
async function layAllForms(dataDir: string, d: LiveDeployment): Promise<string[]> {
  const dirs: string[] = [];
  // Top-level supervisor + step agent dirs (sanitized address).
  dirs.push(join(dataDir, sanitizeAgentAddress(d.supervisorAddress)));
  for (const addr of d.stepAddresses) dirs.push(join(dataDir, sanitizeAgentAddress(addr)));
  // Workflow-run repo.
  dirs.push(join(dataDir, 'workflow-runs', d.workflowRunSlug));
  // Agent-state repos keyed by the raw agentStateRepoId form.
  for (const id of d.agentStateRepoIds) dirs.push(join(dataDir, 'agents', id));
  // The KEYING-BUG form: a step agent dir keyed by sanitized address that
  // lands UNDER agents/. Its name is NOT in agentStateRepoIds, so the old
  // exact-name enumeration would false-delete it for a live deployment.
  for (const addr of d.stepAddresses) {
    dirs.push(join(dataDir, 'agents', sanitizeAgentAddress(addr)));
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'marker'), 'x');
  }
  return dirs;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// activeRunDeploymentIds defaults to "every live deployment has an active
// run" so the existing first-pass tests keep their semantics (a live
// deployment's dirs are kept). The second-pass tests pass an explicit subset.
function okFetch(deployments: LiveDeployment[], activeRunDeploymentIds?: string[]): typeof fetch {
  const active = activeRunDeploymentIds ?? deployments.map((d) => d.deploymentId);
  return (async () =>
    new Response(JSON.stringify({ deployments, activeRunDeploymentIds: active }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'reconciler-'));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function layReserved(): Promise<string[]> {
  const reserved = [
    join(dataDir, 'cache'),
    join(dataDir, 'assets'),
    join(dataDir, '.sidecar-signing'),
  ];
  for (const dir of reserved) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'marker'), 'x');
  }
  return reserved;
}

async function run(
  deployments: LiveDeployment[],
  activeRunDeploymentIds?: string[]
): Promise<void> {
  await reconcileOrphanedDeploymentDirs({
    dataDir,
    hubHttpUrl: 'http://hub',
    sidecarToken: 't',
    logger: silentLogger,
    fetchFn: okFetch(deployments, activeRunDeploymentIds),
  });
}

describe('reconcileOrphanedDeploymentDirs — deployment-id-token keying', () => {
  test('keeps ALL on-disk dir-name forms of a live deployment, deletes ALL forms of a dead one', async () => {
    const live = liveDeployment(LIVE_ID, ['plan', 'execute']);
    const dead = liveDeployment(DEAD_ID, ['plan', 'execute']);
    const liveDirs = await layAllForms(dataDir, live);
    const deadDirs = await layAllForms(dataDir, dead);
    const reserved = await layReserved();

    await run([live]);

    // Every form of the live deployment — including the sanitized-address
    // dir under agents/ whose name is NOT in agentStateRepoIds — survives.
    for (const dir of liveDirs) expect(await exists(dir)).toBe(true);
    for (const dir of reserved) expect(await exists(dir)).toBe(true);
    // Every form of the dead deployment is provably tied to a dead token,
    // so every form is removed.
    for (const dir of deadDirs) expect(await exists(dir)).toBe(false);
  });

  test('keeps a dir under agents/ that has NO deployment-id token (fail-safe)', async () => {
    const live = liveDeployment(LIVE_ID, ['plan']);
    await layAllForms(dataDir, live);
    const legacy = join(dataDir, 'agents', 'legacy-thing');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'marker'), 'x');

    await run([live]);

    // No extractable token -> not provably a deployment dir -> kept.
    expect(await exists(legacy)).toBe(true);
  });

  test('keeps a top-level ins_ dir with no deployment-id token (fail-safe)', async () => {
    const live = liveDeployment(LIVE_ID, ['plan']);
    await layAllForms(dataDir, live);
    const stray = join(dataDir, 'ins_some-other-instance_at_abklabs_com');
    await mkdir(stray, { recursive: true });
    await writeFile(join(stray, 'marker'), 'x');

    await run([live]);

    expect(await exists(stray)).toBe(true);
  });
});

describe('reconcileOrphanedDeploymentDirs — CL-2248 terminal-run second pass', () => {
  test('deletes ALL dir forms of a LIVE deployment that has NO active run', async () => {
    const terminal = liveDeployment(LIVE_ID, ['plan', 'execute']);
    const terminalDirs = await layAllForms(dataDir, terminal);

    // Deployment is live (in `deployments`) but absent from the active-run
    // set: Piece 1 marked its run failed. Its step dirs must be pruned.
    await run([terminal], []);

    for (const dir of terminalDirs) expect(await exists(dir)).toBe(false);
  });

  test('KEEPS all dir forms of a live deployment that DOES have an active run', async () => {
    const active = liveDeployment(LIVE_ID, ['plan', 'execute']);
    const activeDirs = await layAllForms(dataDir, active);

    await run([active], [LIVE_ID]);

    for (const dir of activeDirs) expect(await exists(dir)).toBe(true);
  });

  test('mixed: prunes the terminal live deployment, keeps the active one, deletes the dead one', async () => {
    const activeDep = liveDeployment(LIVE_ID, ['plan']);
    const terminalDep = liveDeployment('ses_1111222233334444aaaabbbbccccdddd', ['plan']);
    const deadDep = liveDeployment(DEAD_ID, ['plan']);
    const activeDirs = await layAllForms(dataDir, activeDep);
    const terminalDirs = await layAllForms(dataDir, terminalDep);
    const deadDirs = await layAllForms(dataDir, deadDep);

    // Both live deployments are reported live; only LIVE_ID has an active run.
    // DEAD_ID is not live at all (first-pass orphan).
    await run([activeDep, terminalDep], [LIVE_ID]);

    for (const dir of activeDirs) expect(await exists(dir)).toBe(true);
    for (const dir of terminalDirs) expect(await exists(dir)).toBe(false);
    for (const dir of deadDirs) expect(await exists(dir)).toBe(false);
  });
});

describe('reconcileOrphanedDeploymentDirs — fail-safes', () => {
  test('FAIL-SAFE: a fetch that throws deletes nothing', async () => {
    const dead = liveDeployment(DEAD_ID, ['plan']);
    const deadDirs = await layAllForms(dataDir, dead);
    const reserved = await layReserved();

    await reconcileOrphanedDeploymentDirs({
      dataDir,
      hubHttpUrl: 'http://hub',
      sidecarToken: 't',
      logger: silentLogger,
      fetchFn: (async () => {
        throw new Error('network down');
      }) as unknown as typeof fetch,
    });

    for (const dir of [...deadDirs, ...reserved]) expect(await exists(dir)).toBe(true);
  });

  test('FAIL-SAFE: a non-200 response deletes nothing', async () => {
    const dead = liveDeployment(DEAD_ID, ['plan']);
    const deadDirs = await layAllForms(dataDir, dead);

    await reconcileOrphanedDeploymentDirs({
      dataDir,
      hubHttpUrl: 'http://hub',
      sidecarToken: 't',
      logger: silentLogger,
      fetchFn: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });

    for (const dir of deadDirs) expect(await exists(dir)).toBe(true);
  });

  test('FAIL-SAFE: an empty live set with orphan-looking dirs deletes nothing', async () => {
    const orphan = liveDeployment('ses_aaaabbbbccccddddeeeeffff00001111', ['plan']);
    const orphanDirs = await layAllForms(dataDir, orphan);

    let warned = false;
    await reconcileOrphanedDeploymentDirs({
      dataDir,
      hubHttpUrl: 'http://hub',
      sidecarToken: 't',
      logger: { info: () => {}, warn: () => (warned = true), error: () => {} },
      fetchFn: okFetch([]),
    });

    for (const dir of orphanDirs) expect(await exists(dir)).toBe(true);
    expect(warned).toBe(true);
  });

  test('idempotent: a second run with the same live set deletes nothing new and does not throw', async () => {
    const live = liveDeployment(LIVE_ID, ['plan']);
    const dead = liveDeployment(DEAD_ID, ['plan']);
    const liveDirs = await layAllForms(dataDir, live);
    await layAllForms(dataDir, dead);

    await run([live]);
    await run([live]);

    for (const dir of liveDirs) expect(await exists(dir)).toBe(true);
  });
});
