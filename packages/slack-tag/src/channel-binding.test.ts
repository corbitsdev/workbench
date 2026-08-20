import { describe, expect, test } from "bun:test";
import {
  resolveOrCreateChannelBinding,
  slackChannelIdFromThreadId,
} from "./channel-binding";
import { createInMemorySlackChannelBindingStore } from "./store";

describe("slackChannelIdFromThreadId", () => {
  test("splits the Chat SDK Slack thread id at the first colon", () => {
    expect(slackChannelIdFromThreadId("C1:1721800000.000100")).toBe("C1");
  });

  test("returns undefined for a thread id with no separator", () => {
    expect(slackChannelIdFromThreadId("no-separator-here")).toBeUndefined();
  });

  test("returns undefined for a thread id starting with the separator", () => {
    expect(slackChannelIdFromThreadId(":1721800000.000100")).toBeUndefined();
  });
});

describe("resolveOrCreateChannelBinding", () => {
  test("provisions a channel and records a binding on first contact", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    let provisionCalls = 0;
    const provisionChannel = async (input: {
      tenantId: string;
      name: string;
      creatorPrincipalId: string;
    }) => {
      provisionCalls += 1;
      expect(input.tenantId).toBe("tenant_1");
      expect(input.name).toBe("general");
      expect(input.creatorPrincipalId).toBe("prn_1");
      return { channelId: "workflowRun_abc" };
    };

    const binding = await resolveOrCreateChannelBinding(
      { bindings, provisionChannel },
      {
        tenantId: "tenant_1",
        slackChannelId: "C1",
        slackChannelName: "general",
        principalId: "prn_1",
      },
    );

    expect(binding.channelId).toBe("workflowRun_abc");
    expect(provisionCalls).toBe(1);
  });

  test("reuses an existing binding without provisioning again", async () => {
    const bindings = createInMemorySlackChannelBindingStore();
    await bindings.createBinding({
      tenantId: "tenant_1",
      slackChannelId: "C1",
      channelId: "workflowRun_existing",
    });

    let provisionCalls = 0;
    const provisionChannel = async () => {
      provisionCalls += 1;
      return { channelId: "workflowRun_should_not_be_used" };
    };

    const binding = await resolveOrCreateChannelBinding(
      { bindings, provisionChannel },
      {
        tenantId: "tenant_1",
        slackChannelId: "C1",
        slackChannelName: "general",
        principalId: "prn_1",
      },
    );

    expect(binding.channelId).toBe("workflowRun_existing");
    expect(provisionCalls).toBe(0);
  });
});
