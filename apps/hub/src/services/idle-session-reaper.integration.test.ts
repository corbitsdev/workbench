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

// In-flight-turn signal stub (CL-2795). The reaper consults this before every
// eviction; the default reports every address idle (no open turn, no status),
// so it never spares a candidate — the guard tests below override it to report a
// busy/open-turn/waiting-approval address and assert the eviction is skipped.
type CollectorStub = Parameters<
  typeof createIdleSessionReaper
>[0]["eventCollectors"];

function idleCollectors(): CollectorStub {
  return {
    getCurrentTurnId: () => null,
    getStatus: () => undefined,
  };
}

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

async function instanceEndedAtOf(instanceId: string): Promise<Date | null> {
  const rows = await client.query<{ ended_at: Date | null }>(
    "SELECT ended_at FROM agent_instance WHERE id = $1",
    [instanceId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw new Error(`instance ${instanceId} missing`);
  return row.ended_at;
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
      eventCollectors: idleCollectors(),
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

  test("CL-2802: eviction never stamps agent_instance.endedAt (sleep/wake conversation retention guard)", async () => {
    // The reaper's only safe-to-sleep property is that `agent_instance.endedAt`
    // stays NULL after eviction: that NULL is what keeps the instance in
    // `liveAgentAddresses` so the sidecar boot-reconciler does not reap its
    // isogit conversation dir on a restart mid-sleep. If a future change ever
    // stamped `agent_instance.endedAt` here, this must fail.
    const address = `ins_myra10@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra10",
      agentName: "Myra",
      address,
    });

    expect(await instanceEndedAtOf("ins_myra10")).toBeNull();

    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async () => {},
      getRoutableAddresses: () => [address],
      eventCollectors: idleCollectors(),
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce(); // seed
    clock += REAP_AFTER + 1;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(1);
    // Existing behavior, for context: the session is ended.
    expect(await sessionStatusOf(sessionId)).toBe("ended");
    // Core regression guard: the instance's endedAt must remain NULL.
    expect(await instanceEndedAtOf("ins_myra10")).toBeNull();
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
      eventCollectors: idleCollectors(),
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
      eventCollectors: idleCollectors(),
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

  test("CL-3767: sleeps a deployable non-personal system agent (Loop) — kind does not gate reapability", async () => {
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
      eventCollectors: idleCollectors(),
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(1);
    expect(ended).toEqual([address]);
    expect(await sessionStatusOf(sessionId)).toBe("ended");
  });

  test("CL-3767: sleeps a SHARED deployable chat agent (Oat) — it now wakes on the next inbound mail", async () => {
    // The mail-route wake middleware (relaunchInstanceIfNeeded, apps/hub
    // index.ts) relaunches a non-routable instance ahead of interchange's
    // mail-send route, so Oat is safe to sleep like every other agent kind.
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
      eventCollectors: idleCollectors(),
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER * 10;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(1);
    expect(ended).toEqual([address]);
    expect(await sessionStatusOf(sessionId)).toBe("ended");
  });

  test("never sleeps the ephemeral file-parser invocation", async () => {
    const address = `ins_fp1@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_fp1",
      agentName: "File Parser",
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
      eventCollectors: idleCollectors(),
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
      eventCollectors: idleCollectors(),
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
      eventCollectors: idleCollectors(),
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

  test("does not sleep an idle agent with an open turn, then sleeps it once the turn finalizes", async () => {
    // CL-2795 in-flight-turn guard: recency aged past the threshold (a long
    // blocking tool call emits no persisted agent.events), but the live
    // collector reports an open turn — the agent is mid-work and must be spared.
    // Once the turn finalizes (getCurrentTurnId null, status idle) and it is
    // still idle, the next sweep sleeps it.
    const address = `ins_myra5@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra5",
      agentName: "Myra",
      address,
    });

    let currentTurnId: string | null = "trn_open";
    let status: "idle" | "busy" | "waiting_approval" = "busy";
    const ended: string[] = [];
    let clock = 1_000_000;
    const reaper = createIdleSessionReaper({
      db,
      endSession: async (a) => {
        ended.push(a);
      },
      getRoutableAddresses: () => [address],
      eventCollectors: {
        getCurrentTurnId: () => currentTurnId,
        getStatus: () => ({ status }),
      },
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce(); // seed
    clock += REAP_AFTER + 1;

    // Idle-past-threshold BUT mid-turn → spared.
    expect((await reaper.sweepOnce()).evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");

    // Turn finalizes; still idle → the next sweep sleeps it.
    currentTurnId = null;
    status = "idle";
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(1);
    expect(ended).toEqual([address]);
    expect(await sessionStatusOf(sessionId)).toBe("ended");
  });

  test("does not sleep an idle agent whose status is busy even with no open turn id", async () => {
    // A busy status alone (no currentTurnId) is enough to spare — the guard is
    // an OR over the two signals.
    const address = `ins_myra8@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra8",
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
      eventCollectors: {
        getCurrentTurnId: () => null,
        getStatus: () => ({ status: "busy" }),
      },
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER + 1;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
    expect(ended).toHaveLength(0);
    expect(await sessionStatusOf(sessionId)).toBe("active");
  });

  test("does not sleep an idle agent that is waiting_approval", async () => {
    // A tool call blocked on an interactive approval is genuinely in-flight —
    // sleeping it would drop the pending approval.
    const address = `ins_myra9@${DOMAIN}`;
    const { sessionId } = await seedChatAgent({
      instanceId: "ins_myra9",
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
      eventCollectors: {
        getCurrentTurnId: () => null,
        getStatus: () => ({ status: "waiting_approval" }),
      },
      reapAfterMs: REAP_AFTER,
      now: () => clock,
    });

    await reaper.sweepOnce();
    clock += REAP_AFTER + 1;
    const result = await reaper.sweepOnce();

    expect(result.evicted).toBe(0);
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
      eventCollectors: idleCollectors(),
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
      eventCollectors: idleCollectors(),
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
