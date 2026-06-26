import { describe, expect, it, mock } from "bun:test";
import type { LogRecord } from "@logtape/logtape";
import { createSentrySink, type SentryClient } from "./sentry-sink";

function makeClient() {
  return {
    captureException: mock((_error: unknown, _hint?: unknown) => "evt-exc"),
    captureMessage: mock((_message: string, _hint?: unknown) => "evt-msg"),
    flush: mock(async () => true),
  } satisfies SentryClient;
}

function record(overrides: Partial<LogRecord>): LogRecord {
  return {
    category: ["api", "workflow"],
    level: "error",
    message: ["something failed"],
    rawMessage: "something failed",
    timestamp: 0,
    properties: {},
    ...overrides,
  } as LogRecord;
}

describe("createSentrySink", () => {
  it("captures an exception when the record carries an Error", () => {
    const client = makeClient();
    const err = new Error("boom");
    createSentrySink(client)(
      record({ properties: { error: err, workflowId: "wf-1" } }),
    );

    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(client.captureMessage).not.toHaveBeenCalled();
    const [captured, context] = client.captureException.mock.calls[0]!;
    expect(captured).toBe(err);
    // Sentry recognizes a CaptureContext only by top-level level/tags/extra
    // keys; it must NOT be nested under a wrapper key or the context is dropped.
    const ctx = context as Record<string, unknown>;
    expect(ctx).not.toHaveProperty("captureContext");
    expect(ctx.level).toBe("error");
    expect(ctx.tags).toMatchObject({ logCategory: "api.workflow" });
    expect(ctx.extra).toMatchObject({
      workflowId: "wf-1",
      logMessage: "something failed",
    });
  });

  it("captures a message when an error-level record has no Error object", () => {
    const client = makeClient();
    createSentrySink(client)(
      record({ rawMessage: "no credential configured", properties: {} }),
    );

    expect(client.captureMessage).toHaveBeenCalledTimes(1);
    expect(client.captureException).not.toHaveBeenCalled();
    expect(client.captureMessage.mock.calls[0]![0]).toBe(
      "no credential configured",
    );
  });

  it("captures fatal records at fatal level", () => {
    const client = makeClient();
    const err = new Error("dead");
    createSentrySink(client)(
      record({ level: "fatal", properties: { error: err } }),
    );

    const [, context] = client.captureException.mock.calls[0]!;
    expect((context as { level: string }).level).toBe("fatal");
  });

  it("ignores records below error level when no warn allowlist is given", () => {
    const client = makeClient();
    const sink = createSentrySink(client);
    for (const level of ["debug", "info", "warning"] as const) {
      sink(record({ level, properties: { error: new Error("x") } }));
    }
    expect(client.captureException).not.toHaveBeenCalled();
    expect(client.captureMessage).not.toHaveBeenCalled();
  });

  it("forwards a warning whose category matches an allowlisted prefix", () => {
    const client = makeClient();
    const sink = createSentrySink(client, [["workflow-host"]]);
    sink(
      record({
        level: "warning",
        category: ["workflow-host", "supervisor"],
        rawMessage: "replayProcessingToInbox on spawn failed",
        properties: {},
      }),
    );
    expect(client.captureMessage).toHaveBeenCalledTimes(1);
    const [, context] = client.captureMessage.mock.calls[0]!;
    expect((context as { level: string }).level).toBe("warning");
    expect(
      (context as { tags: { logCategory: string } }).tags.logCategory,
    ).toBe("workflow-host.supervisor");
  });

  it("ignores a warning whose category is not on the allowlist", () => {
    const client = makeClient();
    const sink = createSentrySink(client, [["workflow-host"]]);
    // The transient WS reconnect category must stay out of Sentry.
    sink(
      record({
        level: "warning",
        category: ["interchange", "hub-agent", "ws"],
        rawMessage: "WebSocket error: Failed to connect",
        properties: {},
      }),
    );
    expect(client.captureMessage).not.toHaveBeenCalled();
    expect(client.captureException).not.toHaveBeenCalled();
  });

  it("matches a prefix only at the start of the category path", () => {
    const client = makeClient();
    const sink = createSentrySink(client, [
      ["interchange", "sidecar", "workflow-run-pack-client"],
    ]);
    // A prefix longer than the record category, or a mid-path match, must not
    // forward.
    sink(
      record({
        level: "warning",
        category: ["interchange", "sidecar"],
        properties: {},
      }),
    );
    expect(client.captureMessage).not.toHaveBeenCalled();
  });

  it("still forwards error-level records regardless of the warn allowlist", () => {
    const client = makeClient();
    const sink = createSentrySink(client, [["workflow-host"]]);
    sink(record({ category: ["api", "other"], properties: {} }));
    expect(client.captureMessage).toHaveBeenCalledTimes(1);
  });
});
