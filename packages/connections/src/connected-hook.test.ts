import { describe, expect, test } from "bun:test";
import {
  fireInferenceCredentialSeedableHook,
  type InferenceCredentialSeedableInfo,
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

  test("logs and swallows a hook failure rather than breaking the connect", async () => {
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
  });
});
