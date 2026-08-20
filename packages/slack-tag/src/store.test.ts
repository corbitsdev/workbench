import { describe, expect, test } from "bun:test";
import { createInMemorySlackChannelBindingStore } from "./store";

describe("SlackChannelBindingStore tenant isolation", () => {
  test("the same Slack channel id in two tenants resolves to two independent bindings", async () => {
    const bindings = createInMemorySlackChannelBindingStore();

    const workspaceA = await bindings.createBinding({
      tenantId: "tenant_a",
      slackChannelId: "C_SHARED",
      channelId: "workflowRun_a",
    });
    const workspaceB = await bindings.createBinding({
      tenantId: "tenant_b",
      slackChannelId: "C_SHARED",
      channelId: "workflowRun_b",
    });

    expect(workspaceA.channelId).toBe("workflowRun_a");
    expect(workspaceB.channelId).toBe("workflowRun_b");

    expect(await bindings.getBinding("tenant_a", "C_SHARED")).toEqual(
      workspaceA,
    );
    expect(await bindings.getBinding("tenant_b", "C_SHARED")).toEqual(
      workspaceB,
    );
  });

  test("a tenant with no binding for a channel never sees another tenant's", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    await bindings.createBinding({
      tenantId: "tenant_a",
      slackChannelId: "C1",
      channelId: "workflowRun_a",
    });

    expect(await bindings.getBinding("tenant_b", "C1")).toBeUndefined();
  });

  test("createBinding is idempotent for the same (tenant, channel) pair", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    const first = await bindings.createBinding({
      tenantId: "tenant_a",
      slackChannelId: "C1",
      channelId: "workflowRun_first",
    });
    const second = await bindings.createBinding({
      tenantId: "tenant_a",
      slackChannelId: "C1",
      channelId: "workflowRun_second",
    });

    expect(second).toEqual(first);
    expect(second.channelId).toBe("workflowRun_first");
  });
});
