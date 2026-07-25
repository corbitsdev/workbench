import { afterEach, describe, expect, mock, test } from "bun:test";
import { toolCredentialEnvKey } from "@workbench/tool-credentials";

const SLACK_ENV = {
  [toolCredentialEnvKey("slack")]: {
    apiKey: "bot-token",
    baseURL: "https://slack.com/api",
  },
};

describe("prospectEngineSlackBridge (CL-4464)", () => {
  afterEach(() => {
    mock.restore();
  });

  test("skips slack_post_message entirely when slackChannelId is absent — a normal, not degraded, outcome", async () => {
    mock.module("@workbench/tools-slack", () => ({
      SLACK_HUB_TOOLS: {
        slack_post_message: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "slack_post_message" },
              handler: async () => {
                throw new Error("should never be called");
              },
            },
          ],
        },
      },
    }));
    const { prospectEngineSlackBridge } = await import("./bridges");
    const runner = prospectEngineSlackBridge(SLACK_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_post_slack_tolerant",
        arguments: { text: "nightly digest" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({ skipped: true });
  });

  test("a thrown underlying Slack failure degrades to a successful outer envelope, never throwing or setting isError", async () => {
    mock.module("@workbench/tools-slack", () => ({
      SLACK_HUB_TOOLS: {
        slack_post_message: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "slack_post_message" },
              handler: async () => {
                throw new Error("channel_not_found");
              },
            },
          ],
        },
      },
    }));
    const { prospectEngineSlackBridge } = await import("./bridges");
    const runner = prospectEngineSlackBridge(SLACK_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_post_slack_tolerant",
        arguments: { slackChannelId: "C123", text: "nightly digest" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      isError: true,
      error: expect.stringContaining("channel_not_found"),
    });
  });

  test("a successful post remaps slackChannelId/text to the underlying channel/text args", async () => {
    let capturedArgs: unknown;
    mock.module("@workbench/tools-slack", () => ({
      SLACK_HUB_TOOLS: {
        slack_post_message: {
          createTools: () => [
            {
              kind: "full" as const,
              definition: { name: "slack_post_message" },
              handler: async (call: { id: string; arguments: unknown }) => {
                capturedArgs = call.arguments;
                return {
                  callId: call.id,
                  isError: false,
                  content: { ok: true },
                };
              },
            },
          ],
        },
      },
    }));
    const { prospectEngineSlackBridge } = await import("./bridges");
    const runner = prospectEngineSlackBridge(SLACK_ENV as never);
    const result = await runner.run(
      {
        id: "call1",
        name: "prospect_engine_post_slack_tolerant",
        arguments: { slackChannelId: "C123", text: "nightly digest" },
      },
      new AbortController().signal,
    );
    expect(result.isError).toBe(false);
    expect(capturedArgs).toEqual({ channel: "C123", text: "nightly digest" });
  });
});
