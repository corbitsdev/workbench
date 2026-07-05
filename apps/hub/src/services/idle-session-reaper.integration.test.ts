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
import { schema as intxSchema } from "@intx/db";
import type { DB } from "@intx/db";
import { deriveDeploymentAddress } from "@intx/workflow-deploy";

import { createIdleSessionReaper } from "./idle-session-reaper";

// CL-2790: the idle chat-session reaper over a real (PGlite) Postgres so the
// candidate join (agent_instance ⋈ agent_session ⋈ agent) and the
// end-the-session write round-trip for real. This EVICTS LIVE sessions, so the
// regression-critical property is asymmetric: an idle chat agent is slept and
// left relaunchable (session ended, instance still `running`), while a recently
// active agent, a non-chat system agent, and a first-seen agent are all spared.

const DOMAIN = "wf.localhost";
const TENANT = "tn-reap";

// Minimal DDL for the three joined tables; only the columns the reaper reads or
// writes. FK-free so the seed is self-contained.
const AGENT_DDL = `
  CREATE TABLE agent (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    creator_principal_id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'deployed',
    current_version text NOT NULL DEFAULT '1',
    tool_packages jsonb NOT NULL DEFAULT '[]',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now()
  );
`;
const SESSION_DDL = `
  CREATE TABLE agent_session (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    agent_id text NOT NULL,
    principal_id text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    ended_at timestamp
  );
`;
const INSTANCE_DDL = `
  CREATE TABLE agent_instance (
    id text PRIMARY KEY,
    agent_id text NOT NULL,
    tenant_id text NOT NULL,
    principal_id text NOT NULL,
    address text NOT NULL UNIQUE,
    version_id text,
    session_id text,
    status text NOT NULL DEFAULT 'deployed',
    sidecar_id text,
    public_key text,
    kernel_id text,
    model_preferences jsonb,
    created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(),
    ended_at timestamp
  );
`;

let client: PGlite;
let db: DB["db"];

async function seedChatAgent(opts: {
  instanceId: string;
  agentName: string;
  address: string;
  sessionStatus?: string;
  instanceStatus?: string;
}): Promise<{ sessionId: string }> {
  const agentId = `agt-${opts.instanceId}`;
  const sessionId = `ses-${opts.instanceId}`;
  await client.exec(
    `INSERT INTO agent (id, tenant_id, creator_principal_id, name) VALUES ('${agentId}', '${TENANT}', 'prn-c', '${opts.agentName}');`,
  );
  await client.exec(
    `INSERT INTO agent_session (id, tenant_id, agent_id, principal_id, status) VALUES ('${sessionId}', '${TENANT}', '${agentId}', 'prn-p', '${opts.sessionStatus ?? "active"}');`,
  );
  await client.exec(
    `INSERT INTO agent_instance (id, agent_id, tenant_id, principal_id, address, session_id, status) VALUES ('${opts.instanceId}', '${agentId}', '${TENANT}', 'prn-p', '${opts.address}', '${sessionId}', '${opts.instanceStatus ?? "running"}');`,
  );
  return { sessionId };
}

async function sessionStatusOf(sessionId: string): Promise<string> {
  const rows = await client.query<{ status: string }>(
    "SELECT status FROM agent_session WHERE id = $1",
    [sessionId],
  );
  return rows.rows[0]?.status ?? "MISSING";
}

async function instanceStatusOf(instanceId: string): Promise<string> {
  const rows = await client.query<{ status: string }>(
    "SELECT status FROM agent_instance WHERE id = $1",
    [instanceId],
  );
  return rows.rows[0]?.status ?? "MISSING";
}

const REAP_AFTER = 30 * 60 * 1000;

// One PGlite instance for the whole file (instantiating the WASM engine per
// test flakes under the full parallel suite). Isolation between tests comes from
// truncating the three tables in beforeEach — required because a sweep scans
// EVERY active session, so a stray row from another test would skew scan/evict
// counts.
beforeAll(async () => {
  client = new PGlite();
  await client.exec(AGENT_DDL);
  await client.exec(SESSION_DDL);
  await client.exec(INSTANCE_DDL);
  db = drizzle(client, { schema: intxSchema }) as unknown as DB["db"];
});

beforeEach(async () => {
  await client.exec(
    "TRUNCATE agent_instance, agent_session, agent RESTART IDENTITY;",
  );
});

afterAll(async () => {
  await client?.close();
});

describe("createIdleSessionReaper", () => {
  test("sleeps a chat session idle past the threshold and leaves it relaunchable", async () => {
    const address = `ins_myra1@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra1",
      agentName: "Myra",
      address,
    });

    const ended: { address: string; reason: string }[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a, reason) => {
        ended.push({ address: a, reason });
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    // First sweep: seeds the tracker, evicts nothing.
    expect((await reaper.sweepOnce()).evicted).toBe(0);
    expect(ended).toHaveLength(0);

    // Advance past the threshold with no activity → slept.
    clock += REAP_AFTER + 1;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(1);
    expect(ended).toEqual([{ address, reason: "idle" }]);
    expect(await sessionStatusOf(sessionId)).toBe("ended");
    // Instance stays relaunchable — NOT stopped.
    expect(await instanceStatusOf("ins_myra1")).toBe("running");
  });

  test("spares a session whose activity is within the threshold", async () => {
    const address = `ins_myra2@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra2",
      agentName: "Myra",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce(); // seed
    clock += REAP_AFTER + 1;
    // Activity lands right before the sweep → lastActive refreshed to now.
    reaper.recordActivity(address);
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("recordActivity resets the idle clock so a would-be-idle agent is spared", async () => {
    const address = `ins_myra3@${DOMAIN}`;
    await seedChatAgent({
      instanceId: "ins_myra3",
      agentName: "Myra",
      address,
    });

    let clock = 1_000_000;
    let evictions = 0;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async () => {
        evictions += 1;
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce(); // seed at t0
    clock += REAP_AFTER - 1; // just under
    reaper.recordActivity(address); // bump to this near-threshold time
    clock += REAP_AFTER - 1; // advance again but < threshold since bump
    expect((await reaper.sweepOnce()).evicted).toBe(0);
    expect(evictions).toBe(0);
  });

  test("never sleeps a non-chat system agent (Loop)", async () => {
    const address = `ins_loop1@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_loop1",
      agentName: "Loop",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("never sleeps a SHARED deployable chat agent (Oat) — it has no on-demand wake", async () => {
    // CL-2790 blocker guard: Oat is a deployable chat agent but only the
    // personal agent (Myra) has a wake path. Sleeping Oat would leave its next
    // message 502-ing with no self-heal, so it must be spared until the
    // universal delivery-seam wake lands.
    const address = `ins_oat1@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_oat1",
      agentName: "Oat",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("never sleeps a workflow supervisor address even if a stray instance row exists", async () => {
    const address = deriveDeploymentAddress({
      deploymentId: "dep_wf1",
      deploymentDomain: DOMAIN,
    });
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_dep_wf1",
      agentName: "Myra",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("does not sleep an idle chat agent that is no longer routable (leaves it to the wedge sweep)", async () => {
    const address = `ins_myra4@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra4",
      agentName: "Myra",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [], // unroutable
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("kill switch OFF makes the reaper a no-op", async () => {
    const address = `ins_myra5@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra5",
      agentName: "Myra",
      address,
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: false,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result).toEqual({ scanned: 0, evicted: 0 });
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("recordActivityForInstance resolves the address and spares the agent", async () => {
    const address = `ins_myra6@${DOMAIN}`;
    await seedChatAgent({
      instanceId: "ins_myra6",
      agentName: "Myra",
      address,
    });

    let clock = 1_000_000;
    let evictions = 0;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async () => {
        evictions += 1;
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce(); // seed
    clock += REAP_AFTER + 1;
    // Awaitable: the resolve settles deterministically (no wall-clock wait).
    await reaper.recordActivityForInstance("ins_myra6");
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(evictions).toBe(0);
  });

  test("does not touch a session that is already ended", async () => {
    const address = `ins_myra7@${DOMAIN}`;
    await seedChatAgent({
      instanceId: "ins_myra7",
      agentName: "Myra",
      address,
      sessionStatus: "ended",
    });

    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      enabled: true,
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    // The candidate query only selects `active` sessions, so an ended session is
    // never scanned.
    expect(result.scanned).toBe(0);
    expect(ended).toHaveLength(0);
  });
});
