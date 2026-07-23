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
  "/library",
  "/library/artifacts",
  "/library/artifacts/art_sample",
  "/library/skills",
  "/library/skills/new",
  "/library/skills/id_sample",
  "/library/agents",
  "/workflows",
  "/workflows/wf_sample",
  "/settings",
  "/settings/connections",
  "/settings/tools/id_sample",
  "/settings/admin/tools",
  "/settings/admin/tools/tool_sample",
  "/settings/admin",
  "/settings/admin/principals",
  "/settings/admin/principals/id_sample",
  "/settings/admin/definitions",
  "/settings/admin/definitions/def_sample",
  "/settings/admin/audit",
  "/settings/owner",
  "/settings/owner/catalog",
  "/settings/owner/capabilities",
  "/settings/owner/capabilities/gamma",
  "/settings/owner/workflows",
  "/settings/owner/demos",
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
    expect(pageContextForPathname("/library/artifacts")).toContain("library");
    expect(pageContextForPathname("/library/artifacts/art-1")).toContain(
      "detail",
    );
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
