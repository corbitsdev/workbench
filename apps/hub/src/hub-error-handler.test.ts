// Exercises `hubErrorHandler` through a real Hono app rather than a
// hand-rolled `Context` double, so the assertions cover exactly what
// `app.onError` actually receives and returns. Errors are reported
// through `@corbits/error-sink`'s real `reportError`, captured the same
// way `packages/error-sink/src/index.test.ts` captures its own sink.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { configureSync, resetSync } from "@intx/log";
import { InferenceResolutionError } from "@corbits/folded-runs";

import { hubErrorHandler } from "./hub-error-handler";

let records: { properties: Record<string, unknown> }[];

function installCapturingSink(): void {
  records = [];
  configureSync({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record as { properties: Record<string, unknown> });
      },
    },
    loggers: [
      { category: ["errors"], sinks: ["capture"], lowestLevel: "debug" },
      { category: ["logtape", "meta"], sinks: [], lowestLevel: "warning" },
    ],
  });
}

beforeEach(() => installCapturingSink());
afterEach(() => resetSync());

describe("hubErrorHandler", () => {
  test("reports the failing route through reportError and answers a generic 500 with a refId", async () => {
    const app = new Hono();
    app.onError(hubErrorHandler());
    app.get("/boom", () => {
      throw new Error("definition asset never materialized");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("internal_error");
    expect(body.error.userMessage).toBe(
      "Something went wrong. Please try again.",
    );
    expect(typeof body.error.refId).toBe("string");
    expect(body.error.refId.length).toBeGreaterThan(0);

    expect(records).toHaveLength(1);
    const properties = records[0]?.properties;
    expect(properties?.operation).toBe("hub.unhandled_route_error");
    expect(properties?.refId).toBe(body.error.refId);
    expect(properties?.extra).toEqual({ path: "/boom", method: "GET" });
  });

  test("maps a guidance-bearing error to a 422 with its own message and a refId", async () => {
    const app = new Hono();
    app.onError(hubErrorHandler());
    app.get("/launch", () => {
      class NamedLaunchError extends Error {
        readonly guidance = "Reduce it to a single step and try again.";
        constructor() {
          super("definition wfd_research is not single-step (2 steps)");
          this.name = "MultiStepFoldUnsupportedError";
        }
      }
      throw new NamedLaunchError();
    });

    const res = await app.request("/launch");

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("MultiStepFoldUnsupportedError");
    expect(body.error.userMessage).toBe(
      "definition wfd_research is not single-step (2 steps)",
    );
    expect(typeof body.error.refId).toBe("string");
    expect(body.error.refId.length).toBeGreaterThan(0);
    expect(records).toHaveLength(1);
    expect(records[0]?.properties.refId).toBe(body.error.refId);
  });

  test("maps InferenceResolutionError to 422 with consumer copy, not 500", async () => {
    const app = new Hono();
    app.onError(hubErrorHandler());
    app.get("/wake", () => {
      throw new InferenceResolutionError(
        "the woken instance",
        'No launchable inference source for model "claude-sonnet-5"',
      );
    });

    const res = await app.request("/wake");

    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; userMessage: string; refId: string };
    };
    expect(body.error.code).toBe("InferenceResolutionError");
    expect(body.error.userMessage).toBe(
      "This agent's model isn't available here.",
    );
    expect(body.error.userMessage).not.toContain("claude-sonnet-5");
    expect(body.error.userMessage).not.toMatch(/cannot resolve an inference/);
    expect(typeof body.error.refId).toBe("string");
  });
});
