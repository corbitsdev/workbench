import { describe, expect, it } from "bun:test";
import { createToolRunner } from "@intx/agent";
import { createLinearTools } from "./index";
import {
  asConnection,
  lastBody,
  makeFetchStub,
  makeRoutingFetchStub,
} from "./test-helpers";

describe("linear_list_webhooks", () => {
  it("lists webhooks", async () => {
    const nodes = [{ id: "w1", url: "https://hook", enabled: true }];
    const fetcher = makeFetchStub({
      data: {
        webhooks: { nodes, pageInfo: { endCursor: null, hasNextPage: false } },
      },
    });
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_list_webhooks", arguments: {} },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual(asConnection(nodes));
    expect(lastBody(fetcher).query).toContain("webhooks(first:");
  });
});

describe("linear_save_webhook", () => {
  it("runs webhookCreate when id is omitted", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "webhookCreate",
        data: { webhookCreate: { success: true, webhook: { id: "w-new" } } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_save_webhook",
        arguments: { url: "https://hook", label: "ci", teamId: "t1" },
      },
      new AbortController().signal,
    );

    const body = lastBody(fetcher);
    expect(body.query).toContain("webhookCreate(input:");
    expect(body.variables).toEqual({
      input: { url: "https://hook", label: "ci", teamId: "t1" },
    });
  });

  it("runs webhookUpdate when id is provided", async () => {
    const fetcher = makeRoutingFetchStub([
      {
        includes: "webhookUpdate",
        data: { webhookUpdate: { success: true, webhook: { id: "w1" } } },
      },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    await runner.run(
      {
        id: "1",
        name: "linear_save_webhook",
        arguments: { id: "w1", url: "https://hook2", enabled: false },
      },
      new AbortController().signal,
    );

    expect(lastBody(fetcher).query).toContain("webhookUpdate(id:");
  });
});

describe("linear_delete_webhook", () => {
  it("runs webhookDelete mutation", async () => {
    const fetcher = makeRoutingFetchStub([
      { includes: "webhookDelete", data: { webhookDelete: { success: true } } },
    ]);
    const runner = createToolRunner(
      createLinearTools({ apiKey: "k", fetcher }),
    );

    const result = await runner.run(
      { id: "1", name: "linear_delete_webhook", arguments: { id: "w1" } },
      new AbortController().signal,
    );

    expect(JSON.parse(String(result.content))).toEqual({ success: true });
    expect(lastBody(fetcher).variables).toEqual({ id: "w1" });
  });
});
