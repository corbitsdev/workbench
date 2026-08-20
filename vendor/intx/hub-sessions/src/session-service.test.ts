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
  deployCodeSourcedWorkflow,
  type DeployCodeSourcedWorkflowArgs,
} from "./session-service";
import { DeployFrameNotSentError } from "./ws/sidecar-handler";

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

// CL-6388: the SHARED code-sourced front must persist its anchor row BEFORE
// the deploy frame goes out. The frame spawns the deployment's child, whose
// first `refs/heads/events` pack push races the deploy ack back to the hub --
// and `receiveWorkflowRunPack` fails closed (`path_violation`) on a missing
// anchor row, so an insert-after-ack ordering rejects every fresh
// deployment's first events pack. These tests pin the ordering contract:
// insert, then frame, then the acked-key stamp; a failed frame removes the
// pre-inserted row so a retried deploy does not collide on the primary key.
type OrderedFakeDb = {
  handle: DeployCodeSourcedWorkflowArgs["db"];
  events: string[];
  insertedValues: Record<string, unknown>[];
  updatedSets: Record<string, unknown>[];
};

function orderedFakeDb(): OrderedFakeDb {
  const state: OrderedFakeDb = {
    handle: undefined as unknown as DeployCodeSourcedWorkflowArgs["db"],
    events: [],
    insertedValues: [],
    updatedSets: [],
  };
  const handle = {
    query: {
      workflowDefinition: {
        findFirst: () => Promise.resolve({ id: DEFINITION_ID }),
      },
      workflowRun: {
        findFirst: () => Promise.resolve(undefined),
      },
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        state.events.push("insert");
        state.insertedValues.push(values);
        return Promise.resolve(undefined);
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          state.events.push("update");
          state.updatedSets.push(values);
          return Promise.resolve(undefined);
        },
      }),
    }),
    delete: () => ({
      where: () => {
        state.events.push("delete");
        return Promise.resolve(undefined);
      },
    }),
  };
  state.handle = handle as unknown as DeployCodeSourcedWorkflowArgs["db"];
  return state;
}

function sharedDeployArgs(
  db: OrderedFakeDb,
  sendAgentDeploy: (agentAddress: string) => Promise<{ publicKey: string }>,
): DeployCodeSourcedWorkflowArgs {
  const projection = {
    id: "wf_shared",
    triggers: [{ type: "manual" }],
    stepOrder: [],
    steps: {},
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
      sendAgentDeploy: (agentAddress: string) => sendAgentDeploy(agentAddress),
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

describe("deployCodeSourcedWorkflow (CL-6388)", () => {
  test("persists the anchor run before the deploy frame is emitted", async () => {
    const db = orderedFakeDb();

    const result = await deployCodeSourcedWorkflow(
      sharedDeployArgs(db, () => {
        db.events.push("frame");
        return Promise.resolve({ publicKey: SUPERVISOR_KEY });
      }),
    );

    expect(result.publicKey).toBe(SUPERVISOR_KEY);
    expect(db.events).toEqual(["insert", "frame", "update"]);
    expect(db.insertedValues[0]).toMatchObject({
      id: ANCHOR_RUN_ID,
      anchorRunId: ANCHOR_RUN_ID,
      tenantId: TENANT,
      definitionId: DEFINITION_ID,
      address: `${ANCHOR_RUN_ID}@${DEPLOYMENT_DOMAIN}`,
      status: "deployed",
    });
  });

  test("stamps the acked supervisor key onto the anchor after the frame", async () => {
    const db = orderedFakeDb();

    await deployCodeSourcedWorkflow(
      sharedDeployArgs(db, () => {
        db.events.push("frame");
        return Promise.resolve({ publicKey: SUPERVISOR_KEY });
      }),
    );

    // The key is only known from the ack, so the pre-frame insert cannot
    // carry it; the post-frame stamp is where it lands.
    expect(db.insertedValues[0]).toMatchObject({ publicKey: null });
    expect(db.updatedSets).toEqual([{ publicKey: SUPERVISOR_KEY }]);
  });

  // CL-6395: a `DeployFrameNotSentError` is proof the `agent.deploy` frame
  // never left the hub (e.g. no sidecar available, or the send itself threw
  // synchronously) -- no child could have spawned against this anchor, so
  // the pre-inserted row is safe to remove.
  test("removes the pre-inserted anchor when the frame provably was not sent", async () => {
    const db = orderedFakeDb();

    await expect(
      deployCodeSourcedWorkflow(
        sharedDeployArgs(db, () => {
          db.events.push("frame");
          return Promise.reject(
            new DeployFrameNotSentError("No sidecar available"),
          );
        }),
      ),
    ).rejects.toThrow(/No sidecar available/);

    expect(db.events).toEqual(["insert", "frame", "delete"]);
    expect(db.updatedSets).toHaveLength(0);
  });

  // CL-6395: an ack-timeout or socket-drop rejection is raised AFTER the
  // frame already went out -- the sidecar may have already spawned the
  // deployment's child against this anchor. Deleting the row here would
  // permanently strand that child on the missing-anchor `path_violation`
  // path with no grants, so the row must survive and the failure is logged
  // as a reconciliation signal instead.
  test("keeps the pre-inserted anchor when the frame failure is post-send", async () => {
    const db = orderedFakeDb();

    await expect(
      deployCodeSourcedWorkflow(
        sharedDeployArgs(db, () => {
          db.events.push("frame");
          return Promise.reject(
            new Error('Deploy of "run_adopted_anchor@runs.example.test" timed out after 30000ms'),
          );
        }),
      ),
    ).rejects.toThrow(/timed out/);

    expect(db.events).toEqual(["insert", "frame"]);
    expect(db.updatedSets).toHaveLength(0);
  });
});
