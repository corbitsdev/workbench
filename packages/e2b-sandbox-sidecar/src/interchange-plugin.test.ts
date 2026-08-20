// Restructured from the private repo faremeter/interchange-e2b-provisioner
// (github.com/faremeter/interchange-e2b-provisioner) at commit c1e3182. We
// now own this code; it is not a vendored path.
import { describe, expect, test } from "bun:test";
import { createAllocationStateStore } from "@corbits/sandbox-sidecar";

import type { ProvisionerConfig } from "./config";
import { createSidecarProvisioner } from "./interchange-plugin";

describe("Interchange plugin adapter", () => {
  test("exposes a stable versioned binding", () => {
    const config: ProvisionerConfig = {
      apiKey: `e2b_${"a".repeat(32)}`,
      template: "template-one",
      dataDir: "/tmp/not-used",
      sandboxTimeoutMs: 60_000,
      requestTimeoutMs: 60_000,
    };
    const provisioner = createSidecarProvisioner({
      config,
      store: createAllocationStateStore("/tmp/not-used/state.json"),
    });

    expect(provisioner.id).toBe("e2b");
    expect(provisioner.apiVersion).toBe(1);
    expect(provisioner.bindingFingerprint).toBe("e2b:v1:template-one");
  });
});
