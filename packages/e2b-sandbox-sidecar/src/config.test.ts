// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.

import { describe, expect, test } from "bun:test";

import { readProvisionerConfig } from "./config";

describe("E2B provisioner configuration", () => {
  test("reads the required boundary configuration", () => {
    expect(
      readProvisionerConfig(
        {
          E2B_API_KEY: `e2b_${"a".repeat(32)}`,
          E2B_TEMPLATE: "template-one",
          E2B_SANDBOX_TIMEOUT_MS: "120000",
        },
        "/tmp/e2b-state",
      ),
    ).toEqual({
      apiKey: `e2b_${"a".repeat(32)}`,
      template: "template-one",
      dataDir: "/tmp/e2b-state",
      sandboxTimeoutMs: 120_000,
      requestTimeoutMs: 60_000,
    });
  });

  test("rejects a relative state path and invalid timeout", () => {
    const base = {
      E2B_API_KEY: `e2b_${"a".repeat(32)}`,
      E2B_TEMPLATE: "template-one",
    };
    expect(() => readProvisionerConfig(base, "relative-state")).toThrow(
      /absolute path/,
    );
    expect(() =>
      readProvisionerConfig(
        {
          ...base,
          E2B_SANDBOX_TIMEOUT_MS: "1000",
        },
        "/tmp/e2b-state",
      ),
    ).toThrow(/at least 60000/);
  });
});
