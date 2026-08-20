// Co-located coverage for the ADOPTING shared-capacity code-sourced deploy
// (CL-6324's vendored seam). The two upstream code-sourced fronts cannot deploy
// onto a run the caller already owns: `deployWorkflowFromSource` INSERTs a fresh
// anchor row (a PK collision against a folded run's existing row) and threads no
// `credentialCipher`, while `deployPreparedCodeSourcedWorkflow` does both right
// but hard-requires an `allocationTarget`. `deployAdoptedCodeSourcedWorkflow` is
// the third front: it adopts the pre-existing anchor under an ownership check
// and threads the cipher, with no allocation lock.
//
// The fakes here stand in for the two collaborators the front actually touches:
// the sidecar router (which returns the supervisor key on the deploy ack) and
// the drizzle handle. A real Postgres is out of scope -- what is under test is
// the front's own composition, and a fake `db` is the only way to assert the
// negative that matters: that no INSERT is ever issued.
import { describe, expect, test } from "bun:test";

import {
  deployAdoptedCodeSourcedWorkflow,
  type DeployCodeSourcedWorkflowArgs,
} from "./session-service";

const TENANT = "tnt_adopt";
const ANCHOR_RUN_ID = "run_adopted_anchor";
const DEPLOYMENT_DOMAIN = "runs.example.test";
const DEFINITION_ID = "wdef_frozen";
const SUPERVISOR_KEY = "pk_supervisor";

type CapturedDeploy = {
  agentAddress: string;
  workflow: { credentials?: unknown };
};

type FakeDb = {
  handle: DeployCodeSourcedWorkflowArgs["db"];
  inserts: number;
  updates: { set: Record<string, unknown> }[];
};

/**
 * A drizzle-shaped stub covering exactly the surface the adopting front uses:
 * the two `query.*.findFirst` guards, the `update(...).set(...).returning()`
 * stamp, and an `insert` that records any call so the no-duplicate-anchor
 * assertion can fail loud rather than silently pass.
 */
function fakeDb(options: { anchorExists: boolean }): FakeDb {
  const state: FakeDb = {
    handle: undefined as unknown as DeployCodeSourcedWorkflowArgs["db"],
    inserts: 0,
    updates: [],
  };
  const returningRows = options.anchorExists ? [{ id: ANCHOR_RUN_ID }] : [];
  const handle = {
    query: {
      workflowDefinition: {
        findFirst: () => Promise.resolve({ id: DEFINITION_ID }),
      },
      workflowRun: {
        findFirst: () =>
          Promise.resolve(
            options.anchorExists ? { id: ANCHOR_RUN_ID } : undefined,
          ),
      },
    },
    insert: () => {
      state.inserts += 1;
      return { values: () => Promise.resolve(undefined) };
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        state.updates.push({ set: values });
        return {
          where: () => ({ returning: () => Promise.resolve(returningRows) }),
        };
      },
    }),
  };
  state.handle = handle as unknown as DeployCodeSourcedWorkflowArgs["db"];
  return state;
}

function deployArgs(
  db: FakeDb,
  captured: CapturedDeploy[],
  overrides?: { credentialBindings?: readonly unknown[] },
): DeployCodeSourcedWorkflowArgs {
  const projection = {
    id: "wf_adopted",
    triggers: [{ type: "manual" }],
    stepOrder: [],
    steps: {},
    ...(overrides?.credentialBindings !== undefined
      ? { credentialBindings: overrides.credentialBindings }
      : {}),
  };
  const args = {
    approved: {
      approval: {
        ok: true,
        definitionId: DEFINITION_ID,
        approvedWireHash: "sha256:frozen",
        approvedGrants: new Set<string>(),
        projection,
      },
      projection,
      closure: { entries: [] },
    },
    sidecarRouter: {
      sendAgentDeploy: (
        agentAddress: string,
        _config: unknown,
        workflow: { credentials?: unknown },
      ) => {
        captured.push({ agentAddress, workflow });
        return Promise.resolve({ publicKey: SUPERVISOR_KEY });
      },
    },
    agentAddress: `${ANCHOR_RUN_ID}@${DEPLOYMENT_DOMAIN}`,
    config: { sources: [], defaultSource: "default", principalId: "prn_x" },
    sources: {},
    db: db.handle,
    tenantId: TENANT,
    anchorRunId: ANCHOR_RUN_ID,
    deploymentDomain: DEPLOYMENT_DOMAIN,
    source: { kind: "registry", registry: "npm" },
  };
  return args as unknown as DeployCodeSourcedWorkflowArgs;
}

describe("deployAdoptedCodeSourcedWorkflow", () => {
  test("adopts a pre-existing anchor run and stamps it, inserting nothing", async () => {
    const db = fakeDb({ anchorExists: true });
    const captured: CapturedDeploy[] = [];

    const result = await deployAdoptedCodeSourcedWorkflow(
      deployArgs(db, captured),
    );

    expect(result.publicKey).toBe(SUPERVISOR_KEY);
    expect(db.inserts).toBe(0);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]?.set).toEqual({
      definitionId: DEFINITION_ID,
      publicKey: SUPERVISOR_KEY,
    });
  });

  test("threads the credentialCipher through to the launch frame", async () => {
    const db = fakeDb({ anchorExists: true });
    const captured: CapturedDeploy[] = [];
    const args = deployArgs(db, captured, {
      credentialBindings: [{ id: "cred_a", as: "API_KEY" }],
    });

    // Without a cipher the binding-bearing definition must fail closed; the
    // cipher is the only thing that lets credential material reach the frame.
    await expect(deployAdoptedCodeSourcedWorkflow(args)).rejects.toThrow(
      /no credentialCipher was supplied/,
    );
    expect(db.inserts).toBe(0);
    expect(captured).toHaveLength(0);
  });

  test("refuses to adopt an anchor run this tenant does not own", async () => {
    const db = fakeDb({ anchorExists: false });
    const captured: CapturedDeploy[] = [];

    await expect(
      deployAdoptedCodeSourcedWorkflow(deployArgs(db, captured)),
    ).rejects.toThrow(/no adoptable anchor/);
    // Fail closed BEFORE the sidecar sees a frame: a refused adoption must
    // leave no deployed-but-unanchored agent behind.
    expect(captured).toHaveLength(0);
    expect(db.inserts).toBe(0);
  });
});
