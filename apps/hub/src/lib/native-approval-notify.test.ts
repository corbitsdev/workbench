import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";

import { schema } from "../db";
import type { HubDb } from "../db";
import { createApprovalsEventBus } from "./approvals-events";
import type { ApprovalEvent } from "./approvals-events";
import {
  publishNativeApprovalCreated,
  publishNativeApprovalResolved,
  withNativeApprovalCreatedNotify,
} from "./native-approval-notify";

function registration(deploymentId: string) {
  return {
    correlationId: "corr-x",
    runId: "run-x",
    deploymentId,
    agentAddress: "ins_x@notify.example.com",
    kind: "approval" as const,
  };
}

const TENANT = "tnt-notify";
const DEPLOYMENT = "dep-notify";

let client: PGlite;
let db: HubDb;

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
});

afterAll(async () => {
  await client?.close();
});

beforeEach(async () => {
  await client.exec(`DELETE FROM workflow_deployment;`);
});

describe("publishNativeApprovalCreated", () => {
  test("publishes a tenant-keyed created event resolved from the deployment", async () => {
    await client.query(
      `insert into workflow_deployment (id, tenant_id, definition_asset_id, address, status) values ($1, $2, $3, $4, 'deployed')`,
      [
        DEPLOYMENT,
        TENANT,
        "ast-notify",
        `ins_${DEPLOYMENT}@notify.example.com`,
      ],
    );
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));

    await publishNativeApprovalCreated(db, bus, DEPLOYMENT);

    expect(seen).toEqual([
      { tenantId: TENANT, sessionId: null, kind: "created" },
    ]);
  });

  test("is a no-op when the deployment is absent (never throws)", async () => {
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));

    await publishNativeApprovalCreated(db, bus, "dep-missing");

    expect(seen).toEqual([]);
  });
});

describe("publishNativeApprovalResolved", () => {
  test("publishes a tenant-keyed resolved event", () => {
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));

    publishNativeApprovalResolved(bus, TENANT);

    expect(seen).toEqual([
      { tenantId: TENANT, sessionId: null, kind: "resolved" },
    ]);
  });

  test("swallows a listener throw so the resolve response is never corrupted", () => {
    const bus = createApprovalsEventBus();
    bus.subscribe(TENANT, () => {
      throw new Error("listener boom");
    });

    expect(() => publishNativeApprovalResolved(bus, TENANT)).not.toThrow();
  });
});

describe("withNativeApprovalCreatedNotify", () => {
  test("publishes created after the register co-write commits", async () => {
    await client.query(
      `insert into workflow_deployment (id, tenant_id, definition_asset_id, address, status) values ($1, $2, $3, $4, 'deployed')`,
      [
        DEPLOYMENT,
        TENANT,
        "ast-notify",
        `ins_${DEPLOYMENT}@notify.example.com`,
      ],
    );
    const bus = createApprovalsEventBus();
    const seen: ApprovalEvent[] = [];
    bus.subscribe(TENANT, (e) => seen.push(e));

    let committed = false;
    const base = async () => {
      committed = true;
    };
    const wrapped = withNativeApprovalCreatedNotify(db, bus, base);

    await wrapped(registration(DEPLOYMENT));

    expect(committed).toBe(true);
    expect(seen).toEqual([
      { tenantId: TENANT, sessionId: null, kind: "created" },
    ]);
  });

  test("a thrown publish does not surface as a registration failure", async () => {
    let committed = false;
    const base = async () => {
      committed = true;
    };
    // A db whose read throws forces the publish to fail; the co-write (base) has
    // already committed. The wrapper must isolate the failure so it is never
    // re-thrown out of registerSignalCorrelation and mis-attributed there.
    const brokenDb = {
      select() {
        throw new Error("boom db");
      },
    } as unknown as HubDb;
    const bus = createApprovalsEventBus();
    const wrapped = withNativeApprovalCreatedNotify(brokenDb, bus, base);

    await expect(wrapped(registration("dep-boom"))).resolves.toBeUndefined();
    expect(committed).toBe(true);
  });

  test("a register failure DOES propagate (publish is never reached)", async () => {
    let published = false;
    const bus = createApprovalsEventBus();
    bus.subscribe(TENANT, () => {
      published = true;
    });
    const base = async () => {
      throw new Error("register failed");
    };
    const wrapped = withNativeApprovalCreatedNotify(db, bus, base);

    await expect(wrapped(registration(DEPLOYMENT))).rejects.toThrow(
      "register failed",
    );
    expect(published).toBe(false);
  });
});
