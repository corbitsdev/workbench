import { describe, expect, test } from "bun:test";
import { parseCampaignConfig } from "./config";
import type { CheckpointRecord, Knee } from "./metrics";
import {
  renderCampaignReport,
  reportVerdict,
  type CampaignReport,
  type Defect,
} from "./report";

function checkpoint(overrides: Partial<CheckpointRecord>): CheckpointRecord {
  return {
    atMessages: 0,
    wallClockMs: 0,
    sendLatencyP50Ms: 0,
    sendLatencyP95Ms: 0,
    sendLatencyMaxMs: 0,
    turnLatencyP50Ms: 0,
    turnLatencyP95Ms: 0,
    turnCount: 0,
    firstTokenP50Ms: 0,
    dbSizeBytes: 0,
    messagePageMs: 0,
    messagePageDeepMs: 0,
    workbenchListMs: 0,
    hubRssBytes: 0,
    sidecarRssBytes: 0,
    collectorFailures: 0,
    routineFiresTotal: 0,
    routineFiresAccepted: 0,
    sendFailures: 0,
    turnFailures: 0,
    ...overrides,
  };
}

function baseReport(overrides: Partial<CampaignReport> = {}): CampaignReport {
  const config = parseCampaignConfig({
    seed: 1,
    targetMessages: 200,
    checkpoints: [0, 100, 200],
    threadReplyRate: 0.2,
    mentionEvery: 10,
    realTurnEvery: 15,
    burstEvery: 20,
    burstSize: 3,
    simDaysPerCheckpointGap: 1,
    restartAtMessages: [],
    providerSwitchAtMessages: [],
    skillEditAtMessages: [],
    spawnAgentAtMessages: [],
  });
  return {
    name: "nightly-longevity",
    startedAt: "2026-08-19T00:00:00.000Z",
    config,
    checkpoints: [
      checkpoint({ atMessages: 0, sendLatencyP50Ms: 40, dbSizeBytes: 1000 }),
      checkpoint({ atMessages: 100, sendLatencyP50Ms: 60, dbSizeBytes: 2000 }),
      checkpoint({ atMessages: 200, sendLatencyP50Ms: 200, dbSizeBytes: 4000 }),
    ],
    defects: [],
    knees: [],
    selfImprovement: [],
    notes: [],
    ...overrides,
  };
}

describe("renderCampaignReport", () => {
  test("includes a summary header with the campaign name and seed", () => {
    const markdown = renderCampaignReport(baseReport());
    expect(markdown).toContain("nightly-longevity");
    expect(markdown).toContain("Seed: 1");
  });

  test("renders one checkpoint table row per checkpoint", () => {
    const markdown = renderCampaignReport(baseReport());
    expect(markdown).toContain("| 0 |");
    expect(markdown).toContain("| 100 |");
    expect(markdown).toContain("| 200 |");
  });

  test("renders self-improvement checks", () => {
    const markdown = renderCampaignReport(
      baseReport({
        selfImprovement: [
          {
            name: "skill edit propagates",
            pass: true,
            detail: "marker seen in reply",
          },
          {
            name: "provider switch survives restart",
            pass: false,
            detail: "timed out",
          },
        ],
      }),
    );
    expect(markdown).toContain("skill edit propagates");
    expect(markdown).toContain("PASS");
    expect(markdown).toContain("provider switch survives restart");
    expect(markdown).toContain("FAIL");
  });

  test("groups the defect log by severity", () => {
    const defects: Defect[] = [
      {
        severity: "S2",
        title: "slow send",
        detail: "p95 rose",
        atMessages: 150,
      },
      {
        severity: "S1",
        title: "dropped message",
        detail: "never persisted",
        atMessages: 180,
      },
    ];
    const markdown = renderCampaignReport(baseReport({ defects }));
    const s1Index = markdown.indexOf("### S1");
    const s2Index = markdown.indexOf("### S2");
    expect(s1Index).toBeGreaterThan(-1);
    expect(s2Index).toBeGreaterThan(-1);
    expect(s1Index).toBeLessThan(s2Index);
    expect(markdown).toContain("dropped message");
    expect(markdown).toContain("slow send");
  });

  test("renders knees and a verdict paragraph", () => {
    const knees: Knee[] = [
      {
        metric: "sendLatencyP50Ms",
        atMessages: 200,
        baseline: 40,
        value: 200,
        ratio: 5,
      },
    ];
    const report = baseReport({ knees });
    const markdown = renderCampaignReport(report);
    expect(markdown).toContain("sendLatencyP50Ms");
    expect(markdown).toContain("## Verdict");
    expect(markdown).toContain(reportVerdict(report));
  });

  test("says no degradation found when there are no knees", () => {
    const verdict = reportVerdict(baseReport({ knees: [] }));
    expect(verdict).toContain("no metric crossing the");
  });
});
