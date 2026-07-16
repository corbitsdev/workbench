import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { pushSchema } from "drizzle-kit/api";
import { createIsogitStore } from "@workbench/storage-isogit";
import type { AgentRepoStore } from "@intx/hub-sessions";
import type { ConversationTurn } from "@intx/types/runtime";
import git from "isomorphic-git";

import { schema } from "../db";
import type { HubDb } from "../db";
import { getMomentDetail } from "./moment-detail";

// A repo store rooted at a temp dir: `getAgentDir(address)` resolves to
// `<root>/<address>`, so a test can seed a real agent-state git repo at the
// path a given instance address maps to (or leave it absent for the gap path).
let repoRoot: string;
const repoStore = {
  repoStore: {
    getRepoDir: (repoId: { kind: string; id: string }) =>
      path.join(repoRoot, repoId.id),
  },
} as unknown as AgentRepoStore;

// Real-Postgres proof of the detail-expansion joins (CL-2738). The shallow
// timeline projection drops tool inputs/outputs, turn parts, and durations;
// these live in interchange-owned `turn_part` and the analytics fact tables.
// This suite pushes the REAL hub + intx drizzle schema into PGlite and drives
// getMomentDetail against seeded rows so the joins (and their tenant/principal
// scoping) are proven against the actual columns, not mocks.

const TENANT = "tn-detail";
const PRINCIPAL = "prn-target";
const OTHER_PRINCIPAL = "prn-other";

let client: PGlite;
let db: HubDb;

const SEEDED_TABLES = [
  "member_agent_instance",
  "agent_instance",
  "agent_session",
  "inference_turn",
  "turn_part",
  "analytics_event",
  "workflow_run_record",
  "workflow_run_fact",
];

async function seedSession(id: string, principalId = PRINCIPAL): Promise<void> {
  await client.query(
    `insert into agent_session (id, tenant_id, agent_id, principal_id, status, created_at, updated_at)
     values ($1, $2, 'agt-x', $3, 'active', now(), now())`,
    [id, TENANT, principalId],
  );
}

async function seedToolCallEvent(args: {
  id: string;
  callId: string;
  principalId?: string;
  sessionId?: string;
}): Promise<void> {
  await client.query(
    `insert into analytics_event (id, tenant_id, principal_id, session_id, event_key, event_type, tool_call_id, occurred_at)
     values ($1, $2, $3, $4, $1, 'tool_call', $5, now())`,
    [
      args.id,
      TENANT,
      args.principalId ?? PRINCIPAL,
      args.sessionId ?? null,
      args.callId,
    ],
  );
}

async function seedToolPart(args: {
  id: string;
  turnId: string;
  sessionId: string;
  ordinal: number;
  metadata: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, metadata)
     values ($1, $2, $3, 'tool', $4, $5::jsonb)`,
    [
      args.id,
      args.turnId,
      args.sessionId,
      args.ordinal,
      JSON.stringify(args.metadata),
    ],
  );
}

async function seedTurn(args: {
  id: string;
  sessionId: string;
  startedAt: string;
  endedAt: string | null;
}): Promise<void> {
  await client.query(
    `insert into inference_turn (id, session_id, instance_id, tenant_id, model, status, started_at, ended_at)
     values ($1, $2, 'ins-x', $3, 'deepseek-v4-flash', 'completed', $4, $5)`,
    [args.id, args.sessionId, TENANT, args.startedAt, args.endedAt],
  );
}

async function seedTextPart(args: {
  id: string;
  turnId: string;
  sessionId: string;
  ordinal: number;
  content: string;
}): Promise<void> {
  await client.query(
    `insert into turn_part (id, turn_id, session_id, type, ordinal, content)
     values ($1, $2, $3, 'text', $4, $5)`,
    [args.id, args.turnId, args.sessionId, args.ordinal, args.content],
  );
}

async function seedRun(args: {
  id: string;
  durationMs: number;
  outcome: string;
}): Promise<void> {
  await client.query(
    `insert into workflow_run_record (id, kind, tenant_id, principal_id, status, created_at, updated_at)
     values ($1, 'last30days', $2, $3, 'completed', now(), now())`,
    [args.id, TENANT, PRINCIPAL],
  );
  await client.query(
    `insert into workflow_run_fact (run_id, tenant_id, kind, outcome, started_at, ended_at, duration_ms, created_at)
     values ($1, $2, 'last30days', $3, now(), now(), $4, now())`,
    [args.id, TENANT, args.outcome, args.durationMs],
  );
}

function detail(kind: string, id: string, principalId = PRINCIPAL) {
  return getMomentDetail({
    db,
    repoStore,
    tenantId: TENANT,
    principalId,
    kind,
    id,
  });
}

beforeAll(async () => {
  client = new PGlite();
  const bootstrap = drizzle(client, { schema });
  const { apply } = await pushSchema(schema, bootstrap as never);
  await apply();
  await client.exec(`SET session_replication_role = 'replica';`);
  db = bootstrap as unknown as HubDb;
  repoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cl3786-int-"));
});

afterAll(async () => {
  await client?.close();
  if (repoRoot !== undefined) {
    await fs.promises.rm(repoRoot, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  for (const table of SEEDED_TABLES) {
    await client.exec(`DELETE FROM "${table}";`);
  }
});

describe("tool_call detail — real input/output from turn_part", () => {
  test("joins the call arguments and result content on tool_call_id", async () => {
    await seedSession("ses-1");
    await seedToolCallEvent({
      id: "evt-1",
      callId: "toolu_1",
      sessionId: "ses-1",
    });
    await seedToolPart({
      id: "tp-call",
      turnId: "turn-1",
      sessionId: "ses-1",
      ordinal: 0,
      metadata: {
        kind: "call",
        callId: "toolu_1",
        name: "search_web",
        arguments: { query: "acme corp" },
      },
    });
    await seedToolPart({
      id: "tp-result",
      turnId: "turn-1",
      sessionId: "ses-1",
      ordinal: 1,
      metadata: {
        kind: "result",
        callId: "toolu_1",
        content: "Found 3 results",
        isError: false,
      },
    });

    const result = await detail("tool_call", "evt-1");
    expect(result?.toolCall).toEqual({
      toolName: "search_web",
      input: { query: "acme corp" },
      output: "Found 3 results",
      isError: false,
    });
  });

  test("reports an honest null when the tool call's parts were never persisted", async () => {
    await seedToolCallEvent({ id: "evt-2", callId: "toolu_2" });

    const result = await detail("tool_call", "evt-2");
    expect(result?.toolCall).toEqual({
      toolName: null,
      input: null,
      output: null,
      isError: false,
    });
  });

  test("surfaces the error flag from a failed tool result", async () => {
    await seedSession("ses-e");
    await seedToolCallEvent({
      id: "evt-e",
      callId: "toolu_e",
      sessionId: "ses-e",
    });
    await seedToolPart({
      id: "tp-err",
      turnId: "turn-e",
      sessionId: "ses-e",
      ordinal: 0,
      metadata: {
        kind: "result",
        callId: "toolu_e",
        content: "boom",
        isError: true,
      },
    });

    const result = await detail("tool_call", "evt-e");
    expect(result?.toolCall?.isError).toBe(true);
    expect(result?.toolCall?.output).toBe("boom");
  });
});

describe("inference_turn detail — parts and derived duration", () => {
  test("returns model, wall-clock duration, and ordered parts", async () => {
    await seedSession("ses-t");
    await seedTurn({
      id: "turn-x",
      sessionId: "ses-t",
      startedAt: "2026-07-01T10:00:00Z",
      endedAt: "2026-07-01T10:00:04Z",
    });
    await seedTextPart({
      id: "tp-1",
      turnId: "turn-x",
      sessionId: "ses-t",
      ordinal: 0,
      content: "hello",
    });
    await seedToolPart({
      id: "tp-2",
      turnId: "turn-x",
      sessionId: "ses-t",
      ordinal: 1,
      metadata: { kind: "call", callId: "c1", name: "lookup", arguments: {} },
    });

    const result = await detail("inference_turn", "turn-x");
    expect(result?.turn?.model).toBe("deepseek-v4-flash");
    expect(result?.turn?.durationMs).toBe(4000);
    expect(result?.turn?.parts.map((p) => p.type)).toEqual(["text", "tool"]);
    const toolPart = result?.turn?.parts.find((p) => p.type === "tool");
    expect(toolPart?.toolName).toBe("lookup");
  });

  async function seedInstance(address: string): Promise<void> {
    await client.query(
      `insert into agent_instance (id, agent_id, tenant_id, principal_id, address, status, created_at, updated_at)
       values ('ins-x', 'agt-x', $1, $2, $3, 'running', now(), now())`,
      [TENANT, PRINCIPAL, address],
    );
  }

  test("attaches the input conversation reconstructed from the agent-state repo", async () => {
    await seedSession("ses-in");
    await seedInstance("myra_at_tenant");
    const dir = path.join(repoRoot, "myra_at_tenant");
    await createIsogitStore(dir);
    // This turn's own inference-done checkpoint: the triggering message and the
    // assistant answer are committed together, authored at endedAt.
    const turns: ConversationTurn[] = [
      {
        role: "system",
        content: [{ type: "text", text: "You are Myra." }],
        timestamp: 0,
      },
      {
        role: "user",
        content: [{ type: "text", text: "who is acme" }],
        timestamp: 0,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Acme is a company." }],
        timestamp: 0,
      },
    ];
    await fs.promises.writeFile(
      path.join(dir, "turns.jsonl"),
      turns.map((t) => JSON.stringify(t)).join("\n") + "\n",
    );
    await git.add({ fs, dir, filepath: "turns.jsonl" });
    await git.commit({
      fs,
      dir,
      message: "checkpoint: inference-done",
      author: {
        name: "sidecar",
        email: "sidecar@interchange.local",
        timestamp: Math.floor(Date.parse("2026-07-01T10:00:02Z") / 1000),
        timezoneOffset: 0,
      },
    });
    await seedTurn({
      id: "turn-in",
      sessionId: "ses-in",
      startedAt: "2026-07-01T10:00:00Z",
      endedAt: "2026-07-01T10:00:02Z",
    });

    const result = await detail("inference_turn", "turn-in");
    // The assistant answer is stripped — input is system + triggering message.
    expect(result?.turn?.input?.map((m) => m.text)).toEqual([
      "You are Myra.",
      "who is acme",
    ]);
    expect(result?.turn?.input?.[0]?.role).toBe("system");
    expect(result?.turn?.inputGap).toBeUndefined();
  });

  test("reports an honest input gap when the agent-state repo is absent", async () => {
    await seedSession("ses-nog");
    await seedInstance("myra_gone");
    await seedTurn({
      id: "turn-nog",
      sessionId: "ses-nog",
      startedAt: "2026-07-01T10:00:00Z",
      endedAt: "2026-07-01T10:00:02Z",
    });

    const result = await detail("inference_turn", "turn-nog");
    expect(result?.turn?.input).toBeUndefined();
    expect(result?.turn?.inputGap).toContain("not available");
  });

  test("leaves duration null while the turn is still running", async () => {
    await seedSession("ses-r");
    await seedTurn({
      id: "turn-open",
      sessionId: "ses-r",
      startedAt: "2026-07-01T10:00:00Z",
      endedAt: null,
    });

    const result = await detail("inference_turn", "turn-open");
    expect(result?.turn?.durationMs).toBeNull();
  });
});

describe("workflow_run detail — real duration from the fact table", () => {
  test("returns the recorded duration and outcome", async () => {
    await seedRun({ id: "run-1", durationMs: 125000, outcome: "completed" });

    const result = await detail("workflow_run", "run-1");
    expect(result?.run).toEqual({ durationMs: 125000, outcome: "completed" });
  });

  test("expands a run whose fact row has not projected yet with null duration", async () => {
    await client.query(
      `insert into workflow_run_record (id, kind, tenant_id, principal_id, status, created_at, updated_at)
       values ('run-pending', 'last30days', $1, $2, 'running', now(), now())`,
      [TENANT, PRINCIPAL],
    );

    const result = await detail("workflow_run", "run-pending");
    expect(result?.run).toEqual({ durationMs: null, outcome: null });
  });
});

describe("authorization scope", () => {
  test("a moment outside the caller's attribution scope resolves to null (404)", async () => {
    await seedSession("ses-1");
    await seedToolCallEvent({
      id: "evt-scope",
      callId: "toolu_s",
      sessionId: "ses-1",
    });
    await seedToolPart({
      id: "tp-s",
      turnId: "turn-s",
      sessionId: "ses-1",
      ordinal: 0,
      metadata: {
        kind: "call",
        callId: "toolu_s",
        name: "secret",
        arguments: { key: "value" },
      },
    });

    const asOwner = await detail("tool_call", "evt-scope", PRINCIPAL);
    expect(asOwner?.toolCall?.toolName).toBe("secret");

    const asOther = await detail("tool_call", "evt-scope", OTHER_PRINCIPAL);
    expect(asOther).toBeNull();
  });

  test("a run belonging to another principal does not resolve", async () => {
    await seedRun({ id: "run-mine", durationMs: 1000, outcome: "completed" });

    const asOther = await detail("workflow_run", "run-mine", OTHER_PRINCIPAL);
    expect(asOther).toBeNull();
  });
});

describe("non-enriched kinds", () => {
  test("resolves to null (404) for a kind the detail layer does not enrich", async () => {
    const result = await detail("session", "ses-anything");
    expect(result).toBeNull();
  });
});
