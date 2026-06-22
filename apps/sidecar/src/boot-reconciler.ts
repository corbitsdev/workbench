// Boot-time reconciler that prunes orphaned on-disk deployment dirs BEFORE
// the orchestrator's hub-link connects (so interchange's `restoreSessions()`
// never sees them). Part 2 of CL-2231.
//
// After a sidecar restart, on-disk dirs from deployments the hub has since
// soft-deleted/superseded are never reclaimed (part 1 only reclaims on a
// live undeploy while the supervisor is still in the in-memory map). They get
// re-established by `restoreSessions()` — the `Unknown agent address`
// reconnect storm + inode bloat.
//
// THE HUB IS IMMUTABLE FROM HERE. This module READS the live deployment set
// from the hub and DELETES only sidecar-local dirs; it never mutates hub
// DB/repo state.
//
// FAIL-SAFE IS PARAMOUNT. This deletes files at startup. If it cannot
// POSITIVELY confirm the live set — any network error, non-200, parse
// failure, or an empty/absent set while the scan finds orphan-looking dirs —
// it logs a warning and deletes NOTHING.

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type } from 'arktype';
import { getLogger } from '@intx/log';
import { LiveDeploymentsResponse } from '@workbench/tool-credentials';

const defaultLogger = getLogger(['sidecar', 'boot-reconciler']);

// Canonical deployment-id token. A workflow `deploymentId` is
// `generateId("session")` = the `ses_` prefix + 32 lowercase hex chars
// (16 random bytes, hex-encoded) — see `generateId` in
// `interchange/packages/hub-common/src/ids.ts`. EVERY on-disk dir-name
// form a deployment produces embeds this exact token verbatim, regardless
// of which subsystem wrote the dir:
//   - agent-state repo:  `agents/<deploymentId>-<stepId>`            (raw id)
//   - session agent dir: `<dataDir>/ins_<deploymentId>-<stepId>_at_<domain>`
//                         `<dataDir>/ins_<deploymentId>_at_<domain>` (supervisor)
//   - workflow-run repo: `workflow-runs/ins_<deploymentId>-<domainslug>`
// (verified against `workflow-host-wiring.ts` ownedDirs + interchange
// `agent-paths.ts` sanitizeAddress + repo-store path computation).
//
// Matching on this token instead of on whole-dir-name equality makes the
// reconciler independent of the agentId-vs-sanitized-address-vs-slug
// naming differences between those subsystems: a candidate dir is only
// ever deleted when a deployment-id token can be POSITIVELY extracted from
// its name AND that token is not in the live set. A dir name with no
// extractable token is never provably a deployment dir, so it is kept.
const DEPLOYMENT_ID_TOKEN = /ses_[0-9a-f]{32}/;

// Extract the deployment-id token from a dir name, or `null` if the name
// carries no canonical token. `null` means "not provably a deployment
// dir" — the caller keeps it.
function extractDeploymentIdToken(dirName: string): string | null {
  const match = DEPLOYMENT_ID_TOKEN.exec(dirName);
  return match === null ? null : match[0];
}

// Top-level dirs under `<dataDir>` that are NEVER deployment dirs and must
// never be considered for deletion. `cache`, `assets`, `.sidecar-signing`
// are the documented non-deployment dirs; `agents` and `workflow-runs` are
// the repo-store prefixes scanned separately, not agent dirs themselves.
const RESERVED_TOP_LEVEL = new Set([
  'cache',
  'assets',
  '.sidecar-signing',
  'agents',
  'workflow-runs',
]);

// Subdir names of `<dataDir>` the repo-store keys deployment repos under.
const AGENT_STATE_DIR = 'agents';
const WORKFLOW_RUN_DIR = 'workflow-runs';

// A deployment AGENT dir (supervisor or step) is the sanitized mail address,
// which always begins `ins_` (every workflow address is `ins_<...>@<...>`).
// The reconciler only ever classifies a top-level dir as a deployment orphan
// when it matches this prefix AND is not reserved — so a stray non-deployment
// dir is never touched.
const DEPLOYMENT_AGENT_DIR_PREFIX = 'ins_';

// Minimal structural logger the reconciler needs. `@intx/log`'s logger
// satisfies this (its `info`/`warn`/`error` accept `(message, properties)`),
// and tests can pass a trivial stub without reproducing its overload soup.
export type ReconcilerLogger = {
  info: (message: string, properties?: Record<string, unknown>) => void;
  warn: (message: string, properties?: Record<string, unknown>) => void;
  error: (message: string, properties?: Record<string, unknown>) => void;
};

export type ReconcileArgs = {
  dataDir: string;
  hubHttpUrl: string;
  sidecarToken: string;
  logger?: ReconcilerLogger;
  // Injected for testability; production uses global `fetch`.
  fetchFn?: typeof fetch;
};

// Names of immediate subdirectories of `dir`. A missing dir (fresh sidecar)
// yields `[]`; any other read failure rethrows so the caller fails safe.
async function listSubdirNames(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
  return dirents.filter((d) => d.isDirectory()).map((d) => String(d.name));
}

// Candidate orphan-looking dirs, classified strictly. Returns absolute paths.
// A dir is a candidate ONLY if it matches a deployment naming pattern in its
// location; everything else (reserved dirs, non-`ins_` top-level dirs) is
// excluded so it can never be deleted regardless of the live set.
async function scanCandidates(dataDir: string): Promise<{
  topLevelAgents: string[];
  workflowRuns: string[];
  agentStates: string[];
}> {
  const topLevel = await listSubdirNames(dataDir);
  const topLevelAgents = topLevel
    .filter((name) => !RESERVED_TOP_LEVEL.has(name))
    .filter((name) => name.startsWith(DEPLOYMENT_AGENT_DIR_PREFIX))
    .map((name) => join(dataDir, name));

  const workflowRuns = (await listSubdirNames(join(dataDir, WORKFLOW_RUN_DIR))).map((name) =>
    join(dataDir, WORKFLOW_RUN_DIR, name)
  );

  const agentStates = (await listSubdirNames(join(dataDir, AGENT_STATE_DIR))).map((name) =>
    join(dataDir, AGENT_STATE_DIR, name)
  );

  return { topLevelAgents, workflowRuns, agentStates };
}

/**
 * Prune on-disk dirs that belong to deployments the hub no longer has live,
 * fail-safely. Runs before the orchestrator connects.
 */
export async function reconcileOrphanedDeploymentDirs(args: ReconcileArgs): Promise<void> {
  const logger = args.logger ?? defaultLogger;
  const fetchFn = args.fetchFn ?? fetch;

  // 1) Positively confirm the live set FIRST. Any failure short-circuits to
  //    "delete nothing".
  let response: Response;
  try {
    response = await fetchFn(`${args.hubHttpUrl}/api/internal/deployments/live`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.sidecarToken}` },
    });
  } catch (err) {
    logger.warn('boot reconciler: live-deployments fetch failed; deleting nothing: {msg}', {
      msg: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!response.ok) {
    logger.warn('boot reconciler: live-deployments fetch returned {status}; deleting nothing', {
      status: response.status,
    });
    return;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    logger.warn(
      'boot reconciler: live-deployments response was not JSON; deleting nothing: {msg}',
      {
        msg: err instanceof Error ? err.message : String(err),
      }
    );
    return;
  }
  const parsed = LiveDeploymentsResponse(payload);
  if (parsed instanceof type.errors) {
    logger.warn(
      'boot reconciler: live-deployments response failed validation; deleting nothing: {summary}',
      {
        summary: parsed.summary,
      }
    );
    return;
  }

  // 2) Scan for orphan-looking dirs.
  let candidates: Awaited<ReturnType<typeof scanCandidates>>;
  try {
    candidates = await scanCandidates(args.dataDir);
  } catch (err) {
    logger.warn('boot reconciler: data-dir scan failed; deleting nothing: {msg}', {
      msg: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const candidateCount =
    candidates.topLevelAgents.length +
    candidates.workflowRuns.length +
    candidates.agentStates.length;

  // 3) Fail-safe on an empty/untrusted live set: an empty set while orphan-
  //    looking dirs exist on disk is treated as untrusted (a hub that lost its
  //    rows, a wrong endpoint, a fresh DB against a populated data dir would
  //    otherwise nuke every live deployment). Delete nothing.
  if (parsed.deployments.length === 0 && candidateCount > 0) {
    logger.warn(
      'boot reconciler: live set is empty but {count} orphan-looking dir(s) exist; treating as untrusted and deleting nothing',
      { count: candidateCount }
    );
    return;
  }

  // 4) The single source of truth for "alive": the set of live deployment
  //    ids. Every kept-or-deleted decision below hinges on whether a
  //    candidate dir's embedded deployment-id token is in this set. The
  //    rich per-deployment shape the hub returns (addresses, slugs, repo
  //    ids) stays useful for diagnostics but is no longer used for
  //    matching, so the token comparison is immune to the naming-form
  //    differences between subsystems.
  const liveDeploymentIds = new Set<string>(parsed.deployments.map((d) => d.deploymentId));

  // CL-2248: deployment ids that still have an in-flight run. A SUBSET of
  // `liveDeploymentIds`. A deployment that is live but absent here has only
  // terminal runs (e.g. Piece 1 marked a restart-orphaned run `failed`); its
  // step session dirs are pruned so restoreSessions() can't re-provision the
  // dead session and re-enter the `Unknown agent address` reconnect loop.
  const activeRunDeploymentIds = new Set<string>(parsed.activeRunDeploymentIds);

  // 5) Delete orphans, best-effort per-dir (one failure never aborts the rest).
  let removed = 0;
  let failed = 0;
  let keptNoToken = 0;
  let removedTerminal = 0;
  async function pruneOrphan(absPath: string): Promise<void> {
    try {
      await rm(absPath, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      failed += 1;
      logger.warn('boot reconciler: failed to remove orphan dir {dir}: {msg}', {
        dir: absPath,
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // A candidate is deleted when its name yields a deployment-id token AND
  // either (first pass) that token is not live, OR (CL-2248 second pass) the
  // token is live but has no in-flight run — its dirs belong to a terminal
  // run and must not be restored. No token -> keep (not provably a deployment
  // dir). Token live AND active-run -> keep.
  async function reconcileCandidate(absPath: string): Promise<void> {
    const token = extractDeploymentIdToken(basename(absPath));
    if (token === null) {
      keptNoToken += 1;
      return;
    }
    if (!liveDeploymentIds.has(token)) {
      await pruneOrphan(absPath);
      return;
    }
    if (!activeRunDeploymentIds.has(token)) {
      removedTerminal += 1;
      await pruneOrphan(absPath);
    }
  }

  for (const abs of candidates.topLevelAgents) await reconcileCandidate(abs);
  for (const abs of candidates.workflowRuns) await reconcileCandidate(abs);
  for (const abs of candidates.agentStates) await reconcileCandidate(abs);

  logger.info(
    'boot reconciler: pruned {removed} orphan dir(s) ({removedTerminal} of them live-but-terminal-run, {failed} failures, {keptNoToken} kept with no deployment-id token) across {live} live deployment(s)',
    {
      removed,
      removedTerminal,
      failed,
      keptNoToken,
      live: parsed.deployments.length,
    }
  );
}

function basename(absPath: string): string {
  const parts = absPath.split('/');
  return parts[parts.length - 1] ?? absPath;
}
