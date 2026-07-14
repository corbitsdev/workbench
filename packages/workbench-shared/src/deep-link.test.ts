import { describe, expect, test } from "bun:test";
import { deepLink, deepLinkPath } from "./deep-link";

describe("deepLinkPath", () => {
  test("artifact", () => {
    expect(deepLinkPath("artifact", "art-1")).toBe("/artifacts/art-1");
  });

  test("workflow_run resolves to the /workflows destination", () => {
    expect(deepLinkPath("workflow_run", "run-1")).toBe("/workflows/run-1");
  });

  test("workflow_trace resolves to the insights trace route", () => {
    expect(deepLinkPath("workflow_trace", "run/1")).toBe(
      "/insights/trace/run%2F1",
    );
  });

  test("task encodes the id into the ?task query", () => {
    expect(deepLinkPath("task", "task 1")).toBe("/inbox?task=task%201");
  });

  test("mail", () => {
    expect(deepLinkPath("mail", "pm-1")).toBe("/inbox/pm-1");
  });

  test("conversation", () => {
    expect(deepLinkPath("conversation", "cnv-1")).toBe("/chats/cnv-1");
  });
});

describe("deepLink", () => {
  test("returns the relative path when no baseUrl is given", () => {
    expect(deepLink("workflow_run", "run-1")).toBe("/workflows/run-1");
  });

  test("prefixes an absolute baseUrl and strips a trailing slash", () => {
    expect(deepLink("workflow_run", "run-1", "https://app.example/")).toBe(
      "https://app.example/workflows/run-1",
    );
    expect(deepLink("mail", "pm-1", "https://app.example")).toBe(
      "https://app.example/inbox/pm-1",
    );
  });
});
