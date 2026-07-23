import { describe, expect, test } from "bun:test";
import { type } from "arktype";
import {
  PROSPECT_ENGINE_CREDIT_CAP,
  PROSPECT_ENGINE_PIPELINE_LIST_ID,
  PROSPECT_ENGINE_SLACK_BALANCE_WARN,
  ProspectEngineIntakePayloadSchema,
  ProspectEngineLedgerSchema,
  ProspectEngineTriggerPayloadSchema,
  buildProspectEngineReportCsv,
  buildProspectEngineReportMarkdown,
  chargeProspectEngineCredits,
  coercePositiveIntId,
  dedupeProspectCandidates,
  emptyProspectEngineLedger,
  enrichProspectEngineTriggerPayload,
  findMissingProspectEngineIntakeFields,
  formatProspectEngineSlackDigest,
  initProspectEngineCreditBudget,
  mergeProspectEngineLedger,
  mergeProspectEngineShortlist,
  parseProspectEngineLedger,
  prospectEngineMailRefs,
  prospectEngineRunDateEt,
  qualifyProspects,
} from "./prospect-engine";

describe("ProspectEngineTriggerPayloadSchema", () => {
  const payload = {
    reason: "scheduled-prospect-engine",
    userAddress: "usr_123@workbench.local",
    userRefId: "usr_123",
    runDate: "2026-07-20",
    artifactTitle: "Prospect engine - 2026-07-20",
    slackChannelId: "C0123456789",
    growthEngineListId: 80089,
    enterpriseEngineListId: 80090,
  };

  test("accepts configured Engine list ids and optional Ramp inputs", () => {
    expect(
      ProspectEngineTriggerPayloadSchema({
        ...payload,
        rampAIIndexInputs: ["AI applications: +20%"],
      }) instanceof type.errors,
    ).toBe(false);
  });

  test("requires identity and both configured Engine list ids", () => {
    for (const key of [
      "userAddress",
      "growthEngineListId",
      "enterpriseEngineListId",
    ] as const) {
      const candidate = { ...payload };
      delete candidate[key];
      expect(
        ProspectEngineTriggerPayloadSchema(candidate) instanceof type.errors,
      ).toBe(true);
    }
  });

  test("accepts a payload with no Slack channel configured", () => {
    const candidate: Record<string, unknown> = { ...payload };
    delete candidate.slackChannelId;
    expect(
      ProspectEngineTriggerPayloadSchema(candidate) instanceof type.errors,
    ).toBe(false);
  });
});

describe("ProspectEngineIntakePayloadSchema", () => {
  test("requires both Engine list ids but not a Slack channel", () => {
    expect(ProspectEngineIntakePayloadSchema({}) instanceof type.errors).toBe(
      true,
    );
    expect(
      ProspectEngineIntakePayloadSchema({
        slackChannelId: "C1",
        growthEngineListId: "12",
        enterpriseEngineListId: 34,
      }) instanceof type.errors,
    ).toBe(false);
    expect(
      ProspectEngineIntakePayloadSchema({
        growthEngineListId: "12",
        enterpriseEngineListId: 34,
      }) instanceof type.errors,
    ).toBe(false);
  });
});

describe("enrichProspectEngineTriggerPayload", () => {
  test("stamps ET runDate, artifactTitle, identity, and coerces list ids", () => {
    // 2026-07-20 06:00 UTC = 02:00 America/New_York (EDT)
    const nowMs = Date.parse("2026-07-20T06:00:00.000Z");
    expect(prospectEngineRunDateEt(nowMs)).toBe("2026-07-20");
    const enriched = enrichProspectEngineTriggerPayload(
      {
        slackChannelId: " C0123 ",
        growthEngineListId: "80089",
        enterpriseEngineListId: "80090",
        verticals: ["AI"],
      },
      nowMs,
      {
        userAddress: "usr_abc@workbench.local",
        userRefId: "usr_abc",
      },
      "scheduled",
    );
    expect(enriched.reason).toBe("scheduled-prospect-engine");
    expect(enriched.userAddress).toBe("usr_abc@workbench.local");
    expect(enriched.userRefId).toBe("usr_abc");
    expect(enriched.runDate).toBe("2026-07-20");
    expect(enriched.artifactTitle).toBe("Prospect engine — 2026-07-20");
    expect(enriched.slackChannelId).toBe("C0123");
    expect(enriched.growthEngineListId).toBe(80089);
    expect(enriched.enterpriseEngineListId).toBe(80090);
    expect(coercePositiveIntId("not-a-number")).toBeUndefined();
  });

  test("leaves slackChannelId absent when never supplied", () => {
    const nowMs = Date.parse("2026-07-20T06:00:00.000Z");
    const enriched = enrichProspectEngineTriggerPayload(
      { growthEngineListId: "80089", enterpriseEngineListId: "80090" },
      nowMs,
      { userAddress: "usr_abc@workbench.local", userRefId: "usr_abc" },
      "scheduled",
    );
    expect(enriched.slackChannelId).toBeUndefined();
  });
});

describe("findMissingProspectEngineIntakeFields", () => {
  test("does not flag a missing Slack channel", () => {
    expect(
      findMissingProspectEngineIntakeFields({
        growthEngineListId: 1,
        enterpriseEngineListId: 2,
      }),
    ).toEqual([]);
  });

  test("flags a genuinely missing required list id", () => {
    expect(
      findMissingProspectEngineIntakeFields({
        slackChannelId: "C1",
        enterpriseEngineListId: 2,
      }),
    ).toEqual(["growthEngineListId"]);
  });
});

describe("ledger parse + merge", () => {
  test("empty content yields empty ledger", () => {
    const ledger = parseProspectEngineLedger("");
    expect(ledger.accounts).toEqual([]);
    expect(ledger.version).toBe(1);
  });

  test("round-trips a valid ledger", () => {
    const seed = emptyProspectEngineLedger("2026-07-20T06:00:00.000Z");
    const merged = mergeProspectEngineLedger({
      ledger: seed,
      runDate: "2026-07-20",
      accounts: [
        {
          organizationId: 1,
          name: "Acme",
          domain: "acme.com",
          lane: "growth",
          score: 72,
          status: "qualified",
        },
      ],
      creditsUsed: 120,
      remainingBalance: 8900,
      nowIso: "2026-07-20T06:30:00.000Z",
    });
    const validated = ProspectEngineLedgerSchema(merged);
    expect(validated instanceof type.errors).toBe(false);
    const again = parseProspectEngineLedger(JSON.stringify(merged));
    expect(again.accounts).toHaveLength(1);
    expect(again.accounts[0]!.organizationId).toBe(1);
  });

  test("merge updates existing org keys (O unique orgs)", () => {
    const seed = mergeProspectEngineLedger({
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-19",
      accounts: [{ organizationId: 1, name: "Acme", score: 70 }],
      creditsUsed: 100,
    });
    const night2 = mergeProspectEngineLedger({
      ledger: seed,
      runDate: "2026-07-20",
      accounts: [{ organizationId: 1, name: "Acme Inc", score: 80 }],
      creditsUsed: 110,
    });
    expect(night2.accounts).toHaveLength(1);
    expect(night2.accounts[0]!.name).toBe("Acme Inc");
    expect(night2.accounts[0]!.firstSeenRunDate).toBe("2026-07-19");
    expect(night2.accounts[0]!.lastSeenRunDate).toBe("2026-07-20");
    expect(night2.creditLog).toHaveLength(2);
  });
});

describe("credit budget", () => {
  test("charges until cap then fails closed", () => {
    let budget = initProspectEngineCreditBudget(1_000);
    expect(budget.cap).toBe(PROSPECT_ENGINE_CREDIT_CAP);
    const first = chargeProspectEngineCredits(budget, 700, 1_000);
    expect(first.charged).toBe(true);
    budget = first.budget;
    const second = chargeProspectEngineCredits(budget, 200, 1_000);
    expect(second.charged).toBe(false);
    expect(second.stopReason).toBe("credit-cap");
    expect(second.budget.used).toBe(700);
  });

  test("wall clock stops further charges", () => {
    const budget = initProspectEngineCreditBudget(1_000, 800, 1000);
    const result = chargeProspectEngineCredits(budget, 10, 1_000 + 1001);
    expect(result.charged).toBe(false);
    expect(result.stopReason).toBe("wall-clock");
  });
});

describe("dedupe", () => {
  test("removes pipeline, ledger, and engine-list overlap", () => {
    const ledger = mergeProspectEngineLedger({
      ledger: emptyProspectEngineLedger(),
      runDate: "2026-07-19",
      accounts: [{ organizationId: 1 }],
      creditsUsed: 0,
    });
    const { kept, removed } = dedupeProspectCandidates({
      candidates: [
        { organizationId: 1, name: "Ledger Hit" },
        { organizationId: 10, name: "Pipeline" },
        { organizationId: 20, name: "Growth list" },
        { organizationId: 30, name: "Fresh" },
        { organizationId: 30, name: "Dup" },
      ],
      ledger,
      pipelineOrgIds: [10],
      growthOrgIds: [20],
      enterpriseOrgIds: [],
    });
    expect(kept.map((c) => c.organizationId)).toEqual([30]);
    expect(removed.map((r) => r.reason).sort()).toEqual(
      ["duplicate", "engine-growth", "ledger", "pipeline"].sort(),
    );
  });
});

describe("qualify + formatters", () => {
  const accounts = [
    {
      organizationId: 1,
      name: "Alpha",
      lane: "growth" as const,
      score: 80,
      domain: "alpha.com",
      wedge: "agent sprawl",
      scoreBreakdown: {
        agentSurface: 25,
        momentum: 15,
        governanceNeed: 15,
        laneFit: 12,
        whyNow: 13,
      },
    },
    {
      organizationId: 2,
      name: "Beta",
      lane: "enterprise" as const,
      score: 50,
      wedge: "weak",
    },
    {
      organizationId: 3,
      name: "Gamma",
      lane: "growth" as const,
      score: 70,
      wedge: "new AI lead",
    },
  ];

  test("qualify keeps 60+ sorted", () => {
    const q = qualifyProspects(accounts);
    expect(q.map((a) => a.organizationId)).toEqual([1, 3]);
  });

  test("markdown and csv include accounts", () => {
    const q = qualifyProspects(accounts);
    const md = buildProspectEngineReportMarkdown({
      runDate: "2026-07-20",
      accounts: q,
      creditsUsed: 200,
    });
    expect(md).toContain("Alpha");
    expect(md).toContain("Gamma");
    const csv = buildProspectEngineReportCsv(q);
    expect(csv).toContain("organizationId");
    expect(csv).toContain("Alpha");
  });

  test("slack digest warns under balance threshold", () => {
    const text = formatProspectEngineSlackDigest({
      runDate: "2026-07-20",
      accounts: qualifyProspects(accounts),
      creditsUsed: 200,
      remainingBudget: 600,
      sumbleCreditBalance: PROSPECT_ENGINE_SLACK_BALANCE_WARN - 1,
      artifactId: "art_1",
      runId: "run_1",
    });
    expect(text).toContain("top accounts");
    expect(text).toContain("Alpha");
    expect(text).toContain(String(PROSPECT_ENGINE_SLACK_BALANCE_WARN));
    expect(text.toLowerCase()).toContain("top up");
  });

  test("mail refs require ids", () => {
    expect(prospectEngineMailRefs("art_1", "run_1")).toEqual([
      { kind: "artifact", ref: "art_1", label: "Open prospect list" },
      { kind: "workflow_run", ref: "run_1", label: "Open Prospect engine" },
    ]);
    expect(() => prospectEngineMailRefs("", "run_1")).toThrow();
  });

  test("mergeProspectEngineShortlist preserves base membership and strips phones", () => {
    const base = [
      { organizationId: 1, name: "Acme", lane: "growth" as const, score: 80 },
      {
        organizationId: 2,
        name: "Beta",
        lane: "enterprise" as const,
        score: 70,
      },
    ];
    const overlay = [
      {
        organizationId: 1,
        contacts: [
          { name: "Ada", email: "a@x.com", phone: "555" } as {
            name: string;
            email: string;
            phone?: string;
          },
        ],
      },
      { organizationId: 99, name: "OnlyInOverlay" },
    ];
    const merged = mergeProspectEngineShortlist(
      base,
      overlay as Parameters<typeof mergeProspectEngineShortlist>[1],
    );
    expect(merged.map((a) => a.organizationId)).toEqual([1, 2]);
    expect(merged[0]?.contacts?.[0]?.email).toBe("a@x.com");
    expect(
      (merged[0]?.contacts?.[0] as { phone?: string } | undefined)?.phone,
    ).toBeUndefined();
    expect(merged[1]?.name).toBe("Beta");
  });
});
