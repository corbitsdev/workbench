/// <reference types="bun" />
import "../test-setup";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

declare global {
  interface Window {
    happyDOM: { setURL: (url: string) => void };
  }
}

mock.module("../lib/hub-api", () => ({
  getMe: () =>
    Promise.resolve({
      userId: "u1",
      userName: "Test User",
      personalTenantId: "tenant-1",
      rootTenantIds: [],
      paInstanceId: null,
      provisioned: true,
      credentialResolved: true,
    }),
}));

mock.module("react-router", () => ({
  useNavigate: () => mock(() => {}),
  useParams: () => ({ id: "skill-1" }),
}));

import { SkillDetail } from "./SkillDetail";

const originalFetch = globalThis.fetch;
let calls: { url: string; method: string; json?: unknown }[] = [];

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const skill = {
  id: "skill-1",
  name: "asap",
  displayName: "ASAP",
  createdAt: "2026-06-17T00:00:00.000Z",
  updatedAt: "2026-06-17T00:00:00.000Z",
  scope: "tenant",
  accessTenantId: "tenant-root",
  ownerUserId: "usr-1",
  ownerName: "Ada Lovelace",
};

const versions = [
  {
    sha: "sha-2",
    shortSha: "bbbbbbb",
    version: 2,
    message: "second",
    authorName: "Ada Lovelace",
    createdAt: "2026-06-17T01:00:00.000Z",
  },
  {
    sha: "sha-1",
    shortSha: "aaaaaaa",
    version: 1,
    message: "first",
    authorName: "Ada Lovelace",
    createdAt: "2026-06-16T00:00:00.000Z",
  },
];

beforeEach(() => {
  window.happyDOM.setURL("http://localhost/");
  calls = [];
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const entry: (typeof calls)[number] = { url: String(url), method };
    if (typeof init?.body === "string") entry.json = JSON.parse(init.body);
    calls.push(entry);
    if (String(url).includes("/skills/skill-1/versions")) {
      return Promise.resolve(
        jsonResponse({ versions, total: versions.length }),
      );
    }
    if (String(url).includes("/skills/skill-1/restore")) {
      return Promise.resolve(jsonResponse({ skill }));
    }
    if (String(url).includes("/skills/skill-1")) {
      return Promise.resolve(
        jsonResponse({
          skill,
          files: [{ path: "SKILL.md", content: "# ASAP" }],
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    React.createElement(
      QueryClientProvider,
      { client },
      React.createElement(SkillDetail),
    ),
  );
}

describe("SkillDetail", () => {
  it("lists versions newest-first and marks the latest as current", async () => {
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Version history"),
    );
    expect(document.body.textContent).toContain("v2");
    expect(document.body.textContent).toContain("bbbbbbb");
    expect(document.body.textContent).toContain("current");
  });

  it("toggles between rendered markdown and raw source", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));

    const toggle = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Source",
    ) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    // Rendered markdown drops the leading '# ' — only raw source shows it.
    expect(document.body.textContent).not.toContain("# ASAP");

    await user.click(toggle);

    expect(document.body.textContent).toContain("# ASAP");
    const pressed = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Preview",
    ) as HTMLButtonElement;
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a legible error when the skill fails to load", async () => {
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/skills/skill-1/versions")) {
        return Promise.resolve(jsonResponse({ versions: [], total: 0 }));
      }
      return Promise.resolve({
        ok: false,
        status: 500,
        headers: { get: () => null },
        json: () => Promise.resolve({ error: "boom" }),
      } as unknown as Response);
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Could not load this skill."),
    );
  });

  it("renders the title once and drops the raw-slug subtitle (CL-2428)", async () => {
    renderPage();
    const titleNodes = await waitFor(() => {
      const matches = Array.from(document.querySelectorAll("p")).filter(
        (p) => p.textContent?.trim() === "ASAP",
      );
      expect(matches.length).toBeGreaterThan(0);
      return matches;
    });
    // Exactly one title element renders the display name.
    expect(titleNodes).toHaveLength(1);
    // The duplicate header line that rendered the raw lowercase slug is gone.
    const slugSubtitle = Array.from(document.querySelectorAll("p")).find(
      (p) => p.textContent?.trim() === "asap",
    );
    expect(slugSubtitle).toBeUndefined();
  });

  it("hides the file tree pane for a single-file skill (CL-2426)", async () => {
    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    expect(document.querySelector(".w-56")).toBeNull();
  });

  it("shows the file tree pane when the skill has multiple files (CL-2426)", async () => {
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/skills/skill-1/versions")) {
        return Promise.resolve(jsonResponse({ versions: [], total: 0 }));
      }
      if (String(url).includes("/skills/skill-1")) {
        return Promise.resolve(
          jsonResponse({
            skill,
            files: [
              { path: "SKILL.md", content: "# ASAP" },
              { path: "scripts/run.ts", content: "export const x = 1;" },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));
    const treePane = document.querySelector(".w-56");
    expect(treePane).not.toBeNull();
    expect(treePane?.textContent).toContain("run.ts");
  });

  it("orders file content above versioning and delete actions (CL-2429)", async () => {
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Version history"),
    );
    const body = document.body.textContent ?? "";
    const fileIdx = body.indexOf("SKILL.md");
    const versionIdx = body.indexOf("Version history");
    const deleteIdx = body.indexOf("Permanently delete this skill");
    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(versionIdx).toBeGreaterThan(fileIdx);
    expect(deleteIdx).toBeGreaterThan(versionIdx);
  });

  it("restores a non-latest version via the restore endpoint", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() =>
      expect(document.body.textContent).toContain("Version history"),
    );

    const restoreButton = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === "Restore",
    ) as HTMLButtonElement;
    await user.click(restoreButton);

    await waitFor(() => {
      expect(
        calls.some((c) => c.url.includes("/restore") && c.method === "POST"),
      ).toBe(true);
    });
    const restoreCall = calls.find((c) => c.url.includes("/restore"));
    expect(restoreCall?.json).toMatchObject({ sha: "sha-1" });
  });

  it("styles the selected file tree row to match the primary nav selection", async () => {
    // The tree pane only renders for multi-file skills (CL-2426), so the
    // selection-style assertion needs a multi-file fixture.
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/skills/skill-1/versions")) {
        return Promise.resolve(jsonResponse({ versions: [], total: 0 }));
      }
      if (String(url).includes("/skills/skill-1")) {
        return Promise.resolve(
          jsonResponse({
            skill,
            files: [
              { path: "SKILL.md", content: "# ASAP" },
              { path: "scripts/run.ts", content: "export const x = 1;" },
            ],
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    }) as unknown as typeof fetch;

    renderPage();
    await waitFor(() => expect(document.body.textContent).toContain("ASAP"));

    const treePane = document.querySelector(".w-56");
    const fileRow = [...(treePane?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "SKILL.md",
    ) as HTMLButtonElement;

    // Source of truth is the AppSidebar nav item: rounded-[10px] +
    // bg-orange/10 font-medium text-orange. The tree row must not regress to
    // the old 4px `rounded`.
    expect(fileRow.className).toContain("rounded-[10px]");
    expect(fileRow.className).toContain("bg-orange/10");
    expect(fileRow.className).toContain("font-medium");
    expect(fileRow.className).toContain("text-orange");
    expect(fileRow.className).not.toMatch(/\brounded\b(?!-)/);
  });
});
