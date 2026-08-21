// Exercises `hubErrorHandler` through a real Hono app rather than a
// hand-rolled `Context` double, so the assertions cover exactly what
// `app.onError` actually receives and returns.
import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { getLogger } from "@intx/log";

import { hubErrorHandler } from "./hub-error-handler";

/** A minimal stand-in for logtape's tagged-template `Logger`, capturing
 * every `.error` call's rendered message for assertions. */
function fakeLogger(): {
  logger: ReturnType<typeof getLogger>;
  messages: string[];
} {
  const messages: string[] = [];
  const logger = {
    error: (strings: TemplateStringsArray, ...values: unknown[]) => {
      messages.push(
        strings.reduce(
          (acc, part, i) =>
            acc + part + (i < values.length ? String(values[i]) : ""),
          "",
        ),
      );
    },
  } as unknown as ReturnType<typeof getLogger>;
  return { logger, messages };
}

describe("hubErrorHandler", () => {
  test("logs the failing route and answers a generic 500 for an ordinary error", async () => {
    const { logger, messages } = fakeLogger();
    const app = new Hono();
    app.onError(hubErrorHandler(logger));
    app.get("/boom", () => {
      throw new Error("definition asset never materialized");
    });

    const res = await app.request("/boom");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("internal_error");
    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("/boom");
    expect(messages[0]).toContain("definition asset never materialized");
  });

  test("maps a guidance-bearing error to a 422 with its own message", async () => {
    const { logger } = fakeLogger();
    const app = new Hono();
    app.onError(hubErrorHandler(logger));
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
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("MultiStepFoldUnsupportedError");
    expect(body.error.message).toBe(
      "definition wfd_research is not single-step (2 steps)",
    );
  });
});
