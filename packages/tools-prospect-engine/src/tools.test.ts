import { describe, expect, test } from "bun:test";
import {
  PROSPECT_ENGINE_CREDIT_CAP,
  emptyProspectEngineLedger,
  mergeProspectEngineLedger,
} from "@workbench/shared";
import {
  createInMemoryProspectEngineBudgetStore,
  createProspectEngineTools,
} from "./tools";

function tool(name: string, store = createInMemoryProspectEngineBudgetStore()) {
  const t = createProspectEngineTools({ budgetStore: store }).find(
    (x) => x.definition.name === name,
  );
  if (t === undefined) throw new Error(`missing tool ${name}`);
  return t;
}

async function call(
  name: string,
  args: Record<string, unknown>,
  store = createInMemoryProspectEngineBudgetStore(),
) {
  const t = tool(name, store);
  if (t.kind !== "full") throw new Error("expected full tool");
  return t.handler(
    {
      id: "call_1",
      name,
      arguments: args,
    },
    new AbortController().signal,
  );
}

describe("prospect-engine tools", () => {
  test("init + charge fail-closed at cap via durable budgetId", async () => {
    const store = createInMemoryProspectEngineBudgetStore();
    const init = await call(
      "prospect_engine_init_budget",
      { nowMs: 1000 },
      store,
    );
    expect(init.isError).toBeUndefined();
    const initBody = init.content as {
      budgetId: string;
      cap: number;
      used: number;
    };
    expect(initBody.cap).toBe(PROSPECT_ENGINE_CREDIT_CAP);
    expect(typeof initBody.budgetId).toBe("string");
    expect(initBody.budgetId.length).toBeGreaterThan(0);

    const charged = await call(
      "prospect_engine_charge_credits",
      {
        budgetId: initBody.budgetId,
        amount: 700,
        nowMs: 1000,
      },
      store,
    );
    expect(charged.isError).toBeUndefined();
    const body = charged.content as {
      charged: boolean;
      budget: { used: number };
    };
    expect(body.charged).toBe(true);
    expect(body.budget.used).toBe(700);

    // Second charge without replaying prior used — store holds cumulative state
    const over = await call(
      "prospect_engine_charge_credits",
      {
        budgetId: initBody.budgetId,
        amount: 200,
        nowMs: 1000,
      },
      store,
    );
    const overBody = over.content as {
      charged: boolean;
      stopReason?: string;
    };
    expect(overBody.charged).toBe(false);
    expect(overBody.stopReason).toBe("credit-cap");
  });

  test("charge rejects reconstructed used:0 when budgetId store holds prior usage", async () => {
    const store = createInMemoryProspectEngineBudgetStore();
    const init = await call(
      "prospect_engine_init_budget",
      { nowMs: 1000 },
      store,
    );
    const { budgetId } = init.content as { budgetId: string };
    await call(
      "prospect_engine_charge_credits",
      { budgetId, amount: 500, nowMs: 1000 },
      store,
    );
    // Agent mistakenly passes a fresh budget with used:0 — store wins
    const again = await call(
      "prospect_engine_charge_credits",
      {
        budgetId,
        budget: {
          used: 0,
          cap: PROSPECT_ENGINE_CREDIT_CAP,
          remaining: PROSPECT_ENGINE_CREDIT_CAP,
          startedAtMs: 1000,
          wallClockMs: 45 * 60 * 1000,
        },
        amount: 400,
        nowMs: 1000,
      },
      store,
    );
    const body = again.content as {
      charged: boolean;
      budget: { used: number };
      stopReason?: string;
    };
    expect(body.charged).toBe(false);
    expect(body.stopReason).toBe("credit-cap");
    expect(store.get(budgetId)?.used).toBe(500);
  });

  test("wall-clock stop is hard on charge", async () => {
    const store = createInMemoryProspectEngineBudgetStore();
    const init = await call("prospect_engine_init_budget", { nowMs: 0 }, store);
    const { budgetId } = init.content as { budgetId: string };
    const late = await call(
      "prospect_engine_charge_credits",
      {
        budgetId,
        amount: 10,
        nowMs: 45 * 60 * 1000 + 1,
      },
      store,
    );
    const body = late.content as {
      charged: boolean;
      stopReason?: string;
    };
    expect(body.charged).toBe(false);
    expect(body.stopReason).toBe("wall-clock");
  });

  test("dedupe removes pipeline overlap", async () => {
    const ledger = mergeProspectEngineLedger({
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-19",
      accounts: [{ organizationId: 1 }],
      creditsUsed: 0,
    });
    const result = await call("prospect_engine_dedupe_candidates", {
      candidates: [
        { organizationId: 1, name: "Ledger" },
        { organizationId: 10, name: "Pipeline" },
        { organizationId: 99, name: "Fresh" },
      ],
      ledger,
      pipelineOrgIds: [10],
      growthOrgIds: [],
      enterpriseOrgIds: [],
    });
    const content = result.content as {
      kept: { organizationId: number }[];
      removed: { reason: string }[];
    };
    expect(content.kept.map((c) => c.organizationId)).toEqual([99]);
    expect(content.removed.length).toBe(2);
  });

  test("parse ledger cold-start returns empty ledger without content", async () => {
    const empty = await call("prospect_engine_parse_ledger", {});
    expect(empty.isError).toBeUndefined();
    expect(
      (empty.content as { ledger: { accounts: unknown[] } }).ledger.accounts,
    ).toEqual([]);

    const errEnvelope = await call("prospect_engine_parse_ledger", {
      content: { isError: true, content: "not found" },
    });
    expect(errEnvelope.isError).toBeUndefined();
    expect(
      (errEnvelope.content as { ledger: { accounts: unknown[] } }).ledger
        .accounts,
    ).toEqual([]);
  });

  test("format report merges baseAccounts + map overlay and strips phones", async () => {
    const store = createInMemoryProspectEngineBudgetStore();
    const init = await call(
      "prospect_engine_init_budget",
      { nowMs: 1000 },
      store,
    );
    const { budgetId } = init.content as { budgetId: string };
    await call(
      "prospect_engine_charge_credits",
      { budgetId, amount: 42, nowMs: 1000 },
      store,
    );

    const result = await call(
      "prospect_engine_format_report",
      {
        runDate: "2026-07-19",
        baseAccounts: [
          {
            organizationId: 1,
            name: "Acme",
            lane: "growth",
            score: 70,
          },
          {
            organizationId: 2,
            name: "Beta",
            lane: "enterprise",
            score: 65,
          },
        ],
        accounts: [
          {
            organizationId: 1,
            contacts: [
              {
                name: "Ada",
                email: "ada@acme.com",
                phone: "+1-555-0100",
              },
            ],
          },
          // overlay-only org is dropped
          { organizationId: 99, name: "Noise" },
        ],
        budgetId,
      },
      store,
    );
    expect(result.isError).toBeUndefined();
    const content = result.content as {
      creditsUsed: number;
      stopReason: string | null;
      accounts: Array<{
        organizationId: number;
        name?: string;
        contacts?: Array<Record<string, unknown>>;
      }>;
    };
    expect(content.creditsUsed).toBe(42);
    expect(content.stopReason).toBeNull();
    expect(content.accounts.map((a) => a.organizationId)).toEqual([1, 2]);
    expect(content.accounts[0]?.name).toBe("Acme");
    expect(content.accounts[0]?.contacts?.[0]?.email).toBe("ada@acme.com");
    expect(content.accounts[0]?.contacts?.[0]?.phone).toBeUndefined();
  });

  test("format report always emits creditsUsed and stopReason for argMaps", async () => {
    const result = await call("prospect_engine_format_report", {
      runDate: "2026-07-19",
      accounts: [
        {
          organizationId: 1,
          name: "Acme",
          lane: "growth",
          score: 70,
        },
      ],
      creditsUsed: 42,
    });
    expect(result.isError).toBeUndefined();
    const content = result.content as {
      creditsUsed: number;
      stopReason: string | null;
      accounts: unknown[];
    };
    expect(content.creditsUsed).toBe(42);
    expect(content.stopReason).toBeNull();
    expect(content.accounts).toHaveLength(1);
  });

  test("extract_list_org_ids projects pipeline/growth/enterprise without collision", async () => {
    const result = await call("prospect_engine_extract_list_org_ids", {
      pipeline: {
        output: {
          callId: "p",
          isError: false,
          content: JSON.stringify({
            organizations: [{ organizationId: 10 }, { id: 11 }],
          }),
        },
      },
      growthList: {
        output: {
          callId: "g",
          isError: false,
          content: JSON.stringify({ organizationIds: [20, 21] }),
        },
      },
      enterpriseList: {
        output: {
          callId: "e",
          isError: false,
          content: JSON.stringify([{ organization_id: 30 }]),
        },
      },
    });
    const content = result.content as {
      pipelineOrgIds: number[];
      growthOrgIds: number[];
      enterpriseOrgIds: number[];
    };
    expect(content.pipelineOrgIds.sort()).toEqual([10, 11]);
    expect(content.growthOrgIds.sort()).toEqual([20, 21]);
    expect(content.enterpriseOrgIds).toEqual([30]);
  });

  test("format report + slack digest shapes", async () => {
    const accounts = [
      {
        organizationId: 1,
        name: "Alpha",
        lane: "growth",
        score: 80,
        wedge: "agent stack hiring",
      },
    ];
    const report = await call("prospect_engine_format_report", {
      runDate: "2026-07-20",
      accounts,
      creditsUsed: 100,
    });
    const reportBody = report.content as { body: string; csv: string };
    expect(reportBody.body).toContain("Alpha");
    expect(reportBody.csv).toContain("organizationId");

    const digest = await call("prospect_engine_format_slack_digest", {
      runDate: "2026-07-20",
      accounts,
      creditsUsed: 100,
      remainingBudget: 700,
      sumbleCreditBalance: 1500,
      artifactId: "art_1",
      runId: "run_1",
    });
    const text = (digest.content as { text: string }).text;
    expect(text).toContain("Alpha");
    expect(text.toLowerCase()).toContain("top up");
  });

  test("mail refs", async () => {
    const refs = await call("prospect_engine_format_mail_refs", {
      artifactId: "art_1",
      runId: "run_1",
    });
    expect(refs.isError).toBeUndefined();
    expect((refs.content as { refs: unknown[] }).refs).toHaveLength(2);
  });

  // mailRefs is now a native `action` step — `ActionPrimitive` has
  // no error-swallow, so a missing artifactId/runId must degrade to a
  // successful outer envelope carrying { isError: true, error } in content,
  // never an `isError: true` ToolResult (that would throw unconditionally
  // on the action dispatch path — `step-tool-harness.ts`).
  test("mail refs tolerates a missing artifactId without setting the outer isError", async () => {
    const refs = await call("prospect_engine_format_mail_refs", {
      runId: "run_1",
    });
    expect(refs.isError).toBeUndefined();
    expect(refs.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("artifactId"),
    });
  });

  test("mail refs tolerates a missing runId without setting the outer isError", async () => {
    const refs = await call("prospect_engine_format_mail_refs", {
      artifactId: "art_1",
    });
    expect(refs.isError).toBeUndefined();
    expect(refs.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("runId"),
    });
  });

  test("merge ledger serializes for write_artifact body", async () => {
    const merged = await call("prospect_engine_merge_ledger", {
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-20",
      accounts: [{ organizationId: 5, name: "Zed", score: 70 }],
      creditsUsed: 50,
    });
    const content = merged.content as {
      body: string;
      ledger: { accounts: unknown[] };
    };
    expect(content.ledger.accounts).toHaveLength(1);
    expect(JSON.parse(content.body).accounts).toHaveLength(1);
  });

  test("merge ledger emits body for write_artifact", async () => {
    const merged = await call("prospect_engine_merge_ledger", {
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-20",
      accounts: [],
      creditsUsed: 0,
    });
    const content = merged.content as { body: string };
    expect(typeof content.body).toBe("string");
    expect(JSON.parse(content.body)).toHaveProperty("accounts");
  });

  test("qualify aliases the shortlist as baseAccounts", async () => {
    const qualified = await call("prospect_engine_qualify", {
      candidates: [{ organizationId: 1, score: 80, lane: "growth" }],
    });
    const content = qualified.content as {
      accounts: unknown[];
      baseAccounts: unknown[];
    };
    expect(content.baseAccounts).toEqual(content.accounts);
  });

  test("extract candidates from reply parses a discover/score JSON reply", async () => {
    const result = await call("prospect_engine_extract_candidates_from_reply", {
      reply: JSON.stringify({
        candidates: [{ organizationId: 7, name: "Delta" }],
        notes: "ignored",
      }),
    });
    expect(result.isError).toBeUndefined();
    expect(
      (result.content as { candidates: { organizationId: number }[] })
        .candidates,
    ).toEqual([{ organizationId: 7, name: "Delta" }]);
  });

  test("extract candidates from reply fails loud on missing/invalid reply", async () => {
    const missing = await call(
      "prospect_engine_extract_candidates_from_reply",
      {},
    );
    expect(missing.isError).toBe(true);

    const badJson = await call(
      "prospect_engine_extract_candidates_from_reply",
      {
        reply: "not json",
      },
    );
    expect(badJson.isError).toBe(true);

    const noField = await call(
      "prospect_engine_extract_candidates_from_reply",
      {
        reply: JSON.stringify({ notes: "no candidates key" }),
      },
    );
    expect(noField.isError).toBe(true);
  });

  test("extract map reveal overlay parses accounts/creditsCharged/stopReason", async () => {
    const result = await call("prospect_engine_extract_map_reveal_overlay", {
      reply: JSON.stringify({
        accounts: [{ organizationId: 1, contacts: [] }],
        creditsCharged: 30,
        stopReason: null,
      }),
    });
    expect(result.isError).toBeUndefined();
    const content = result.content as {
      accounts: unknown[];
      creditsUsed?: number;
      stopReason?: string;
    };
    expect(content.accounts).toHaveLength(1);
    expect(content.creditsUsed).toBe(30);
    expect(content.stopReason).toBeUndefined();
  });

  test("extract map reveal overlay is tolerant of a missing or bad reply (thin/failed map)", async () => {
    const missing = await call(
      "prospect_engine_extract_map_reveal_overlay",
      {},
    );
    expect(missing.isError).toBeUndefined();
    expect(missing.content).toEqual({});

    const badJson = await call("prospect_engine_extract_map_reveal_overlay", {
      reply: "not json",
    });
    expect(badJson.isError).toBeUndefined();
    expect(badJson.content).toEqual({});
  });
});
