// WORKBENCH DELTA (CL-7362, see VENDORED.md): coverage for the vendored
// `approvals?: ProbeApprovalPolicy` seam threaded through
// `InstallAndApproveWorkflowSourceParams` -> `buildInstallArgs` ->
// `installAndApproveWorkflowSource`. Asserts a caller-supplied empty
// `ApprovalSet` reaches the gate (so nothing is pre-approved, and the gate's
// `grants_not_approved` arm reports the full probed grant surface), and that
// the freeze writer -- `db.transaction`, which `createDbFrozenApprovalWriter`
// invokes only on the gate's `ok:true` arm -- is never called for that
// non-approving policy.
import { describe, expect, test } from "bun:test";

import { computeWireDefinitionHash } from "@intx/types/wire-definition-hash";

import { createSessionService } from "./session-service";
import type { CommittedTreeEntry } from "./repo-store/types";

const DEFINITION_ASSET_ID = "wf_preview_asset";
const COMMIT_SHA = "c".repeat(40);

/** A one-file, dependency-free workflow package: enough for
 * `resolveSourceWorkflowClosure`'s single-package path (root declares no
 * `workspaces`) to resolve with an empty closure. */
const PACKAGE_JSON = JSON.stringify({
  name: "wf-preview-fixture",
  version: "1.0.0",
});

/** A minimal `CommittedReads`-shaped fake over the one-file tree above --
 * exactly the surface `committedReadsToSourceTree` reads from. */
function fakeCommittedReads() {
  const files = new Map<string, Uint8Array>([
    ["package.json", new TextEncoder().encode(PACKAGE_JSON)],
  ]);
  return {
    listDir: (dir: string): Promise<CommittedTreeEntry[]> =>
      Promise.resolve(
        dir === ""
          ? [{ name: "package.json", oid: "oid_package_json", type: "blob" }]
          : [],
      ),
    readBlobByOid: (oid: string): Promise<Uint8Array> => {
      if (oid !== "oid_package_json") {
        throw new Error(`fakeCommittedReads: no blob at oid ${oid}`);
      }
      const bytes = files.get("package.json");
      if (bytes === undefined) throw new Error("unreachable");
      return Promise.resolve(bytes);
    },
    treeOid: (dir: string): Promise<string | null> =>
      Promise.resolve(dir === "" || dir === "." ? "oid_root_tree" : null),
  };
}

describe("installAndApproveWorkflowSource (CL-7362 preview approval policy)", () => {
  test("an empty ApprovalSet returns grants_not_approved with the full probed surface, and never freezes", async () => {
    const projection = {
      id: "wf_preview_definition",
      triggers: [{ type: "manual" }],
      stepOrder: [],
      steps: {},
    };
    const wireHash = await computeWireDefinitionHash(projection);
    const probedGrants = ["credential:acme-api"];

    let transactionCalls = 0;
    const fakeDb = {
      transaction: (_fn: unknown) => {
        transactionCalls += 1;
        return Promise.resolve(undefined);
      },
    };

    const sessionService = createSessionService({
      sidecarRouter: {
        sendProbe: () =>
          Promise.resolve({ projection, grants: probedGrants, wireHash }),
      },
      agentRepoStore: {
        repoStore: {
          openCommittedReadsAtCommit: (
            _principal: unknown,
            _repoId: unknown,
            commitSha: string,
          ) =>
            Promise.resolve(
              commitSha === COMMIT_SHA ? fakeCommittedReads() : null,
            ),
          resolveRef: () => Promise.resolve(COMMIT_SHA),
          createPack: () =>
            Promise.resolve({ pack: new Uint8Array(), ref: "refs/heads/main" }),
        },
      },
      db: fakeDb,
      toolPackageRegistries: {
        httpRegistries: new Map([["npmjs", { url: "https://registry.npmjs.test" }]]),
        defaultRegistry: "npmjs",
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fakes cover exactly the surface this test path reads; see the file header.
    } as any);

    const result = await sessionService.installAndApproveWorkflowSource({
      source: {
        kind: "asset",
        assetId: DEFINITION_ASSET_ID,
        package: { format: "source", commitSha: COMMIT_SHA },
      },
      entry: "workflow.ts",
      definitionAssetId: DEFINITION_ASSET_ID,
      // The delta under test: an empty ApprovalSet pre-approves nothing.
      approvals: new Set<string>(),
    });

    expect(result.approval.ok).toBe(false);
    if (result.approval.ok) throw new Error("unreachable");
    expect(result.approval.reason).toBe("grants_not_approved");
    if (result.approval.reason !== "grants_not_approved") {
      throw new Error("unreachable");
    }
    expect(result.approval.unapprovedGrants).toEqual(probedGrants);
    expect(transactionCalls).toBe(0);
  });
});
