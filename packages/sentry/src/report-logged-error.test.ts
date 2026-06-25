import { describe, expect, it, mock } from "bun:test";
import { reportLoggedError, toLoggedError } from "./report-logged-error";

describe("toLoggedError", () => {
  it("returns Error instances unchanged", () => {
    const err = new Error("boom");
    expect(toLoggedError(err)).toBe(err);
  });

  it("wraps non-Error values", () => {
    expect(toLoggedError("boom").message).toBe("boom");
  });
});

describe("reportLoggedError", () => {
  it("logs an Error and flushes Sentry", async () => {
    const log = { error: mock(() => undefined) };
    await reportLoggedError(
      log,
      "Background task failed",
      new Error("reddit scan"),
      {
        workflowId: "wf-1",
      },
    );

    expect(log.error).toHaveBeenCalledWith("Background task failed", {
      workflowId: "wf-1",
      error: expect.any(Error),
    });
  });
});
