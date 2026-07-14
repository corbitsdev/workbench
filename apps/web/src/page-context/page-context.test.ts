/// <reference types="bun" />
import "../test-setup";
import { describe, expect, it } from "bun:test";
import { PAGE_CONTEXT_CATALOG, PAGE_CONTEXT_FALLBACK } from "./catalog";
import { pageContextForPathname } from "./resolve";

/** Sample pathnames for every primary AppShell route (keep in sync with router.tsx). */
const PRIMARY_PATH_SAMPLES = [
  "/",
  "/chats",
  "/chats/thr_sample",
  "/inbox",
  "/inbox/msg_sample",
  "/artifacts",
  "/artifacts/art_sample",
  "/workflows",
  "/workflows/wf_sample",
  "/settings",
  "/settings/connections",
  "/settings/tools/id_sample",
  "/skills",
  "/skills/new",
  "/skills/id_sample",
  "/admin/tools",
  "/admin/tools/tool_sample",
  "/admin",
  "/admin/principals",
  "/admin/principals/id_sample",
  "/admin/definitions",
  "/admin/definitions/def_sample",
  "/admin/audit",
  "/owner",
  "/owner/catalog",
  "/owner/capabilities",
  "/owner/capabilities/gamma",
  "/owner/workflows",
  "/owner/demos",
  "/insights",
  "/insights/runs",
  "/insights/users/id_sample",
  "/insights/trace/run_sample",
] as const;

describe("pageContextForPathname", () => {
  it("resolves inbox for index and /inbox", () => {
    const ctx = pageContextForPathname("/inbox");
    expect(ctx).toContain("Inbox");
    expect(ctx).not.toBe(PAGE_CONTEXT_FALLBACK);
    expect(pageContextForPathname("/")).toBe(ctx);
  });

  it("resolves artifacts list vs detail", () => {
    expect(pageContextForPathname("/artifacts")).toContain("library");
    expect(pageContextForPathname("/artifacts/art-1")).toContain("detail");
  });

  it("catalog copy must not look like secrets or PII", () => {
    const forbidden = /@|password|api[_-]?key|Bearer\s|sk-[a-z]/i;
    for (const entry of PAGE_CONTEXT_CATALOG) {
      expect(forbidden.test(entry.context)).toBe(false);
    }
  });
});

describe("catalog route coverage", () => {
  it("every primary shell route has non-fallback context", () => {
    for (const pathname of PRIMARY_PATH_SAMPLES) {
      const ctx = pageContextForPathname(pathname);
      expect(ctx).not.toBe(PAGE_CONTEXT_FALLBACK);
    }
  });
});