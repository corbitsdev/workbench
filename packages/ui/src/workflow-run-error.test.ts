import { describe, expect, test } from "bun:test";
import type { RunState } from "@intx/workflow";
import {
  classifyRunError,
  describeLiveInferenceIssue,
  failedRunError,
} from "./workflow-run-error";

describe("classifyRunError", () => {
  test("classifies a provider auth failure and names the provider without echoing the raw body", () => {
    const raw = "Attio API error: 403 Forbidden";
    const classified = classifyRunError(raw);
    expect(classified.kind).toBe("external-auth");
    expect(classified.userMessage).toBe(
      "Attio declined the request (403). Check the connected Attio credential's access and try again.",
    );
    expect(classified.raw).toBe(raw);
  });

  test("classifies a 401 as an auth failure", () => {
    const classified = classifyRunError("Attio API error: 401 Invalid token");
    expect(classified.kind).toBe("external-auth");
    expect(classified.userMessage).toContain(
      "Attio declined the request (401)",
    );
    expect(classified.userMessage).not.toContain("Invalid token");
  });

  test("classifies a provider rate limit with a wait-and-retry message", () => {
    const classified = classifyRunError(
      'ScrapeCreators API error: 429 Too Many Requests {"detail":"quota"}',
    );
    expect(classified.kind).toBe("external-rate-limit");
    expect(classified.userMessage).toBe(
      "ScrapeCreators is rate-limiting requests right now. Wait a few minutes and run this again.",
    );
    expect(classified.userMessage).not.toContain("quota");
  });

  test("classifies a provider 5xx as an upstream outage", () => {
    const classified = classifyRunError("Attio API error: 502 Bad Gateway");
    expect(classified.kind).toBe("external-unavailable");
    expect(classified.userMessage).toBe(
      "Attio had a problem on its end (502). Try running this again shortly.",
    );
  });

  test("classifies other provider statuses as a rejected request", () => {
    const classified = classifyRunError(
      'Attio API error: 400 {"validation_errors":[{"path":["data","values"]}]}',
    );
    expect(classified.kind).toBe("external-rejected");
    expect(classified.userMessage).toBe(
      "Attio rejected the request (400). Try again, and contact your workspace admin if it keeps failing.",
    );
    expect(classified.userMessage).not.toContain("validation_errors");
  });

  test("classifies network-level failures without leaking hosts or syscalls", () => {
    for (const raw of [
      "fetch failed",
      "connect ECONNREFUSED 10.0.3.7:5433",
      "getaddrinfo ENOTFOUND internal-hub.railway.internal",
      "The socket connection was closed unexpectedly",
      "Request timed out after 30000ms",
    ]) {
      const classified = classifyRunError(raw);
      expect(classified.kind).toBe("network");
      expect(classified.userMessage).toBe(
        "A service this workflow depends on couldn't be reached. Try running it again in a moment.",
      );
    }
  });

  test("defaults everything unknown to a generic internal message, never the raw text", () => {
    for (const raw of [
      'step-tool-harness: deterministic step "attio.createTask" argMap failed validation: must be an object',
      'duplicate key value violates unique constraint "workflow_run_pkey"',
      "Cannot read properties of undefined (reading 'id')\n    at run (/app/apps/hub/src/x.ts:12:3)",
      "no agent address registered for ins_ses_01aabbcc",
    ]) {
      const classified = classifyRunError(raw);
      expect(classified.kind).toBe("internal");
      expect(classified.userMessage).toBe(
        "Something went wrong inside this workflow run. Try running it again; if it keeps failing, contact your workspace admin.",
      );
      expect(classified.userMessage).not.toContain("ins_");
      expect(classified.raw).toBe(raw);
    }
  });
});

describe("failedRunError", () => {
  const failed = (message: string) =>
    ({
      phase: "failed",
      steps: new Map([["brief", { phase: "failed", lastError: { message } }]]),
    }) as unknown as RunState;

  test("returns the classified error for a failed run, preserving the raw message", () => {
    const state = failed("Attio API error: 403 Forbidden");
    const classified = failedRunError(state);
    expect(classified?.kind).toBe("external-auth");
    expect(classified?.raw).toBe("Attio API error: 403 Forbidden");
  });

  test("returns null when the run has not failed or no step carries an error", () => {
    expect(failedRunError(null)).toBeNull();
    const noMessage = {
      phase: "failed",
      steps: new Map([["brief", { phase: "failed" }]]),
    } as unknown as RunState;
    expect(failedRunError(noMessage)).toBeNull();
  });
});

describe("describeLiveInferenceIssue", () => {
  test("names a timeout distinctly from a generic transient error", () => {
    const timeout = describeLiveInferenceIssue("timeout");
    const retryable = describeLiveInferenceIssue("retryable");
    expect(timeout).toBe("Model provider timed out — retrying");
    expect(retryable).not.toBe(timeout);
  });

  test("every known InferenceError category resolves to a distinct message", () => {
    const categories = [
      "retryable",
      "context_overflow",
      "credential_failure",
      "quota_exhausted",
      "fatal",
      "aborted",
      "timeout",
      "protocol_mismatch",
    ];
    const messages = categories.map(describeLiveInferenceIssue);
    expect(new Set(messages).size).toBe(categories.length);
  });

  test("every category except context_overflow keeps the retry framing", () => {
    const retryingCategories = [
      "retryable",
      "credential_failure",
      "quota_exhausted",
      "fatal",
      "aborted",
      "timeout",
      "protocol_mismatch",
    ];
    for (const category of retryingCategories) {
      expect(describeLiveInferenceIssue(category).toLowerCase()).toContain(
        "retrying",
      );
    }
  });

  test("context_overflow does not claim the step is retrying", () => {
    const message = describeLiveInferenceIssue("context_overflow");
    expect(message.toLowerCase()).not.toContain("retrying");
    expect(message).toBe("Input is too large for the model");
  });

  test("falls back to a generic retrying message for an unrecognized category", () => {
    expect(describeLiveInferenceIssue("some-future-category")).toBe(
      "Model provider had a problem — retrying",
    );
  });
});
