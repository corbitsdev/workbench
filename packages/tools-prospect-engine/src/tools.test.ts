import { describe, expect, test } from "bun:test";
import {
  PROSPECT_ENGINE_CREDIT_CAP,
  emptyProspectEngineLedger,
  mergeProspectEngineLedger,
} from "@workbench/shared";
import { createProspectEngineTools } from "./tools";

function tool(name: string) {
  const t = createProspectEngineTools().find((x) => x.definition.name === name);
  if (t === undefined) throw new Error(`missing tool ${name}`);
  return t;
}

async function call(name: string, args: Record<string, unknown>) {
  const t = tool(name);
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
  test("init + charge fail-closed at cap", async () => {
    const init = await call("prospect_engine_init_budget", { nowMs: 1000 });
    expect(init.isError).toBeUndefined();
    const budget = (init.content as { cap: number }).cap;
    expect(budget).toBe(PROSPECT_ENGINE_CREDIT_CAP);

    const charged = await call("prospect_engine_charge_credits", {
      budget: init.content,
      amount: 700,
      nowMs: 1000,
    });
    expect(charged.isError).toBeUndefined();
    const body = charged.content as {
      charged: boolean;
      budget: { used: number };
    };
    expect(body.charged).toBe(true);

    const over = await call("prospect_engine_charge_credits", {
      budget: body.budget,
      amount: 200,
      nowMs: 1000,
    });
    const overBody = over.content as {
      charged: boolean;
      stopReason?: string;
    };
    expect(overBody.charged).toBe(false);
    expect(overBody.stopReason).toBe("credit-cap");
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
    expect((empty.content as { ledger: { accounts: unknown[] } }).ledger.accounts)
      .toEqual([]);

    const errEnvelope = await call("prospect_engine_parse_ledger", {
      content: { isError: true, content: "not found" },
    });
    expect(errEnvelope.isError).toBeUndefined();
    expect(
      (errEnvelope.content as { ledger: { accounts: unknown[] } }).ledger
        .accounts,
    ).toEqual([]);
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

  test("merge ledger serializes for write_artifact body", async () => {
    const merged = await call("prospect_engine_merge_ledger", {
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-20",
      accounts: [{ organizationId: 5, name: "Zed", score: 70 }],
      creditsUsed: 50,
    });
    const content = merged.content as {
      content: string;
      ledger: { accounts: unknown[] };
    };
    expect(content.ledger.accounts).toHaveLength(1);
    expect(JSON.parse(content.content).accounts).toHaveLength(1);
  });
});
