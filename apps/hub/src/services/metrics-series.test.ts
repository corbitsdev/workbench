import { describe, expect, it } from "bun:test";

import {
  buildMetricsSeries,
  isMetricsBucket,
  sumTokenClasses,
  type ActiveInstanceDay,
} from "./metrics-series";

describe("isMetricsBucket", () => {
  it("accepts the three granularities and rejects others", () => {
    expect(isMetricsBucket("day")).toBe(true);
    expect(isMetricsBucket("week")).toBe(true);
    expect(isMetricsBucket("month")).toBe(true);
    expect(isMetricsBucket("hour")).toBe(false);
    expect(isMetricsBucket("")).toBe(false);
  });
});

describe("sumTokenClasses", () => {
  it("sums all five token classes", () => {
    expect(
      sumTokenClasses({
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 4,
        cacheWriteTokens: 8,
        thinkingTokens: 16,
      }),
    ).toBe(31);
  });
});

describe("buildMetricsSeries — daily", () => {
  it("emits a continuous zero-filled row for every day in the range", () => {
    const series = buildMetricsSeries({
      bucket: "day",
      range: { startDate: "2026-07-01", endDate: "2026-07-03" },
      today: "2026-07-06",
      artifactDates: ["2026-07-01", "2026-07-03", "2026-07-03"],
      deployedDates: ["2026-07-02"],
      activeInstanceDays: [{ instanceId: "i1", date: "2026-07-02" }],
      tokenDaily: [{ date: "2026-07-02", tokens: 500 }],
    });

    expect(series.map((p) => p.bucketStart)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(series.map((p) => p.artifactsCreated)).toEqual([1, 0, 2]);
    expect(series.map((p) => p.tokensSpent)).toEqual([0, 500, 0]);
    expect(series.map((p) => p.agentsDeployed)).toEqual([0, 1, 0]);
    // Active only on the day the instance recorded work — not a lifespan.
    expect(series.map((p) => p.agentsActive)).toEqual([0, 1, 0]);
  });

  it("separates deployed (new) from active (did work)", () => {
    // i0 worked all three days but was created before the range (so it never
    // appears in deployedDates); i2 was created + worked on days 1-2.
    const activeInstanceDays: ActiveInstanceDay[] = [
      { instanceId: "i0", date: "2026-07-01" },
      { instanceId: "i0", date: "2026-07-02" },
      { instanceId: "i0", date: "2026-07-03" },
      { instanceId: "i2", date: "2026-07-01" },
      { instanceId: "i2", date: "2026-07-02" },
    ];
    const series = buildMetricsSeries({
      bucket: "day",
      range: { startDate: "2026-07-01", endDate: "2026-07-03" },
      today: "2026-07-06",
      artifactDates: [],
      deployedDates: ["2026-07-01"],
      activeInstanceDays,
      tokenDaily: [],
    });

    expect(series.map((p) => p.agentsDeployed)).toEqual([1, 0, 0]);
    expect(series.map((p) => p.agentsActive)).toEqual([2, 2, 1]);
  });

  it("counts a repeat-active instance once per bucket", () => {
    const series = buildMetricsSeries({
      bucket: "day",
      range: { startDate: "2026-07-01", endDate: "2026-07-01" },
      today: "2026-07-06",
      artifactDates: [],
      deployedDates: [],
      // Same instance appears twice for one day (multiple model rollup rows).
      activeInstanceDays: [
        { instanceId: "i1", date: "2026-07-01" },
        { instanceId: "i1", date: "2026-07-01" },
        { instanceId: "i2", date: "2026-07-01" },
      ],
      tokenDaily: [],
    });
    expect(series[0]?.agentsActive).toBe(2);
  });

  it("returns an empty series when an all-time range has no data", () => {
    expect(
      buildMetricsSeries({
        bucket: "day",
        range: {},
        today: "2026-07-06",
        artifactDates: [],
        deployedDates: [],
        activeInstanceDays: [],
        tokenDaily: [],
      }),
    ).toEqual([]);
  });

  it("anchors an all-time range at the earliest data date", () => {
    const series = buildMetricsSeries({
      bucket: "day",
      range: {},
      today: "2026-07-03",
      artifactDates: ["2026-07-02"],
      deployedDates: ["2026-07-01"],
      activeInstanceDays: [],
      tokenDaily: [],
    });
    expect(series.map((p) => p.bucketStart)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(series.map((p) => p.artifactsCreated)).toEqual([0, 1, 0]);
    expect(series.map((p) => p.agentsDeployed)).toEqual([1, 0, 0]);
  });
});

describe("buildMetricsSeries — week/month roll-up", () => {
  it("rolls days into Monday-anchored weeks, counting active once per week", () => {
    // 2026-06-29 is a Monday; range spans two ISO weeks.
    const series = buildMetricsSeries({
      bucket: "week",
      range: { startDate: "2026-06-29", endDate: "2026-07-07" },
      today: "2026-07-10",
      artifactDates: ["2026-06-30", "2026-07-06", "2026-07-07"],
      deployedDates: ["2026-06-29"],
      // i1 worked three days of week one — must count once for that week.
      activeInstanceDays: [
        { instanceId: "i1", date: "2026-06-29" },
        { instanceId: "i1", date: "2026-06-30" },
        { instanceId: "i1", date: "2026-07-01" },
        { instanceId: "i1", date: "2026-07-06" },
      ],
      tokenDaily: [
        { date: "2026-06-30", tokens: 100 },
        { date: "2026-07-06", tokens: 200 },
      ],
    });

    expect(series.map((p) => p.bucketStart)).toEqual([
      "2026-06-29",
      "2026-07-06",
    ]);
    expect(series.map((p) => p.artifactsCreated)).toEqual([1, 2]);
    expect(series.map((p) => p.tokensSpent)).toEqual([100, 200]);
    expect(series.map((p) => p.agentsActive)).toEqual([1, 1]);
    expect(series.map((p) => p.agentsDeployed)).toEqual([1, 0]);
  });

  it("rolls days into calendar months", () => {
    const series = buildMetricsSeries({
      bucket: "month",
      range: { startDate: "2026-06-15", endDate: "2026-08-10" },
      today: "2026-08-20",
      artifactDates: ["2026-06-20", "2026-07-04", "2026-07-31"],
      deployedDates: ["2026-07-04"],
      activeInstanceDays: [
        { instanceId: "i1", date: "2026-07-04" },
        { instanceId: "i1", date: "2026-07-15" },
      ],
      tokenDaily: [{ date: "2026-07-15", tokens: 999 }],
    });

    expect(series.map((p) => p.bucketStart)).toEqual([
      "2026-06-01",
      "2026-07-01",
      "2026-08-01",
    ]);
    expect(series.map((p) => p.artifactsCreated)).toEqual([1, 2, 0]);
    expect(series.map((p) => p.tokensSpent)).toEqual([0, 999, 0]);
    // i1 worked twice in July — one distinct instance for the month.
    expect(series.map((p) => p.agentsActive)).toEqual([0, 1, 0]);
    expect(series.map((p) => p.agentsDeployed)).toEqual([0, 1, 0]);
  });
});
