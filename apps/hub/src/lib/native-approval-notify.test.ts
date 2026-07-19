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
} from "./native-approval-notify";

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
});
