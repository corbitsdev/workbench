import { describe, expect, it } from "bun:test";

import { buildMetricsCsv, metricsCsvFilename } from "./csv-export";
import type { MetricsPoint } from "../../lib/hub-api";

function point(overrides: Partial<MetricsPoint>): MetricsPoint {
  return {
    bucketStart: "2026-07-01",
    agentsDeployed: 0,
    agentsActive: 0,
    tokensSpent: 0,
    artifactsCreated: 0,
    ...overrides,
  };
}

describe("buildMetricsCsv", () => {
  it("writes a header plus one row per bucket, including zero rows", () => {
    const csv = buildMetricsCsv([
      point({
        bucketStart: "2026-07-01",
        agentsDeployed: 2,
        agentsActive: 5,
        tokensSpent: 1234,
        artifactsCreated: 3,
      }),
      point({ bucketStart: "2026-07-02" }),
    ]);

    expect(csv).toBe(
      "date,agents_deployed,agents_active,tokens_spent,artifacts_created\n" +
        "2026-07-01,2,5,1234,3\n" +
        "2026-07-02,0,0,0,0\n",
    );
  });

  it("emits only the header for an empty series", () => {
    expect(buildMetricsCsv([])).toBe(
      "date,agents_deployed,agents_active,tokens_spent,artifacts_created\n",
    );
  });
});

describe("metricsCsvFilename", () => {
  it("encodes an explicit range", () => {
    expect(
      metricsCsvFilename({ startDate: "2026-07-01", endDate: "2026-07-31" }),
    ).toBe("insights-daily-2026-07-01_2026-07-31.csv");
  });

  it("labels an open start as all-time", () => {
    expect(metricsCsvFilename({ endDate: "2026-07-31" })).toBe(
      "insights-daily-all_2026-07-31.csv",
    );
  });
});
