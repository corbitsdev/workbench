import { describe, expect, spyOn, test } from "bun:test";
import * as errorSink from "@corbits/error-sink";
import { fireConnectedHook, type ServiceConnectedInfo } from "./connected-hook";

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
    await expect(fireConnectedHook(undefined, () => {}, connectedInfo())).resolves.toBeUndefined();
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
