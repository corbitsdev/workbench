import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import {
  fireConnectedHook,
  fireInferenceCredentialSeedableHook,
  type InferenceCredentialSeedableInfo,
  type ServiceConnectedInfo,
} from "./connected-hook";

function seedableInfo(): InferenceCredentialSeedableInfo {
  return {
    userId: "user_1",
    tenantId: "tenant_1",
    tenantDomain: "tenant-1.example",
    principalId: "principal_1",
    provider: "ollama",
    apiKey: "secret",
  };
}

function connectedInfo(): ServiceConnectedInfo {
  return {
    tenantId: "tenant_1",
    principalId: "principal_1",
    connectorId: "github",
    displayName: "GitHub",
  };
}

describe("fireConnectedHook", () => {
  test("does nothing when no hook is wired", async () => {
    await expect(
      fireConnectedHook(undefined, () => {}, connectedInfo()),
    ).resolves.toBeUndefined();
  });

  test("logs and reports a hook failure rather than breaking the connect", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const logged: string[] = [];
    await expect(
      fireConnectedHook(
        () => {
          throw new Error("card settle unavailable");
        },
        (line) => logged.push(line),
        connectedInfo(),
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "fire_connected_hook",
      tenantId: "tenant_1",
      extra: { connectorId: "github" },
    });
    report.mockRestore();
  });
});

describe("fireInferenceCredentialSeedableHook", () => {
  test("does nothing when no hook is wired", async () => {
    await expect(
      fireInferenceCredentialSeedableHook(undefined, () => {}, seedableInfo()),
    ).resolves.toBeUndefined();
  });

  test("calls the hook with the connect's tenant, provider, and key", async () => {
    const calls: InferenceCredentialSeedableInfo[] = [];
    await fireInferenceCredentialSeedableHook(
      (info) => {
        calls.push(info);
      },
      () => {},
      seedableInfo(),
    );
    expect(calls).toEqual([seedableInfo()]);
  });

  test("logs and reports a hook failure rather than breaking the connect", async () => {
    const report = spyOn(errorSink, "reportError").mockReturnValue("ref_test");
    const logged: string[] = [];
    await expect(
      fireInferenceCredentialSeedableHook(
        () => {
          throw new Error("drain unavailable");
        },
        (line) => logged.push(line),
        seedableInfo(),
      ),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("tenant_1");
    expect(logged[0]).toContain("drain unavailable");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toMatchObject({
      operation: "fire_inference_credential_seedable_hook",
      tenantId: "tenant_1",
      extra: { provider: "ollama" },
    });
    report.mockRestore();
  });
});
