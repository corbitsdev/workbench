import { describe, expect, test } from "bun:test";
import { createProcessSidecarProvisioner, readProcessProvisionerConfig } from "./process";
import { createFakeSidecarProcessRunner } from "./fake-process-runner";

function fingerprint(role: "deployment" | "probe", port: number, dataDir: string, entry: string) {
  return createProcessSidecarProvisioner({
    role,
    runner: createFakeSidecarProcessRunner(),
    config: readProcessProvisionerConfig({
      env: {
        PROCESS_PROVISIONER_SIDECAR_ENTRY: entry,
        SIDECAR_CREDENTIAL_ENCRYPTION_KEY: "k".repeat(32),
      },
      dataDir,
      hubWebSocketUrl: `ws://127.0.0.1:${port}/api/sidecars/ws`,
    }),
  }).bindingFingerprint;
}

describe("process provisioner binding fingerprint", () => {
  test("is stable across hub restarts that change the port or install path", () => {
    expect(fingerprint("deployment", 3000, "/srv/a/data", "/srv/a/sidecar.ts")).toBe(
      fingerprint("deployment", 4123, "/srv/b/data", "/srv/b/sidecar.ts"),
    );
  });

  test("still distinguishes roles", () => {
    expect(fingerprint("deployment", 3000, "/srv/a", "/srv/a/s.ts")).not.toBe(
      fingerprint("probe", 3000, "/srv/a", "/srv/a/s.ts"),
    );
  });
});
