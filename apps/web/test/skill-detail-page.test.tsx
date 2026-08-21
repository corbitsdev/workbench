// The skill detail page at /skills/<name> (CL-6416): the editor, the
// diff-confirmed save and its head precondition, newline handling, the
// version list, compare, and restore. Every case stubs `fetch` at the
// registry seam the page reads (`/api/tenants/:id/skills/...`) — no live
// server.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { SkillDetailPage } from "../src/pages/skill-detail-page";
import { TestQueryProvider } from "./test-query-provider";

const TENANT = "tnt_1";
const NAME = "triage";
const HEAD_BODY = "Read the report.\nPick one label.";
const HEAD_SHA = "abcdef1234";
const OLDER_SHA = "0123456789";

const SKILL = {
  assetId: "ast_1",
  name: NAME,
  description: "Sorts inbound issues.",
  scope: "private",
  creatorPrincipalId: "prn_1",
  updatedAtIso: "2026-08-05T11:00:00.000Z",
  body: HEAD_BODY,
};

const VERSIONS = [
  {
    commitSha: HEAD_SHA,
    message: "Update triage",
    author: "Ada",
    committedAtIso: "2026-08-05T11:00:00.000Z",
    current: true,
  },
  {
    commitSha: OLDER_SHA,
    message: "Create triage",
    author: "Grace",
    committedAtIso: "2026-08-04T11:00:00.000Z",
    current: false,
  },
];

const BASE = `/api/tenants/${TENANT}/skills/${NAME}`;

type Reply = { readonly status: number; readonly body: unknown };

/** One reply per key, or a queue consumed in order so a test can say
 * "this call fails, the next one succeeds". */
type Stub = Reply | readonly Reply[];

const ok = (body: unknown): Reply => ({ status: 200, body });

function defaultStubs(): Record<string, Stub> {
  return {
    [`GET ${BASE}`]: ok({
      skill: SKILL,
      pinnedBy: [{ definitionId: "def_1", name: "Research Buddy" }],
    }),
    [`GET ${BASE}/versions`]: ok({ versions: VERSIONS }),
    [`GET ${BASE}/versions/${OLDER_SHA}`]: ok({
      skill: { ...SKILL, body: "Read the report." },
    }),
    [`PUT ${BASE}`]: ok({ skill: SKILL }),
    [`POST ${BASE}/restore`]: ok({ skill: SKILL }),
    [`PUT ${BASE}/scope`]: ok({ skill: SKILL }),
  };
}

let stubs: Record<string, Stub> = {};
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let requested: { method: string; path: string; body: unknown }[] = [];
const originalFetch = globalThis.fetch;

function stubRegistry(): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    requested.push({
      method,
      path,
      body:
        init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const stub = stubs[`${method} ${path}`];
    if (stub === undefined) {
      return new Response(JSON.stringify({ error: { message: "no stub" } }), {
        status: 404,
      });
    }
    const reply = Array.isArray(stub)
      ? stub.length > 1
        ? ((stubs[`${method} ${path}`] = stub.slice(1)), stub[0])
        : stub[0]
      : (stub as Reply);
    if (reply === undefined) throw new Error("empty stub queue");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requested = [];
  stubs = defaultStubs();
  stubRegistry();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function mount(): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <SkillDetailPage
          tenantId={TENANT}
          name={NAME}
          now={Date.parse("2026-08-05T12:00:00.000Z")}
        />
      </TestQueryProvider>,
    );
  });
  await settle();
  if (container === null) throw new Error("container went away");
  return container;
}

function buttonsIn(scope: ParentNode): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll("button"));
}

function buttonNamed(scope: ParentNode, label: string): HTMLButtonElement {
  const found = buttonsIn(scope).find((button) =>
    button.textContent?.includes(label),
  );
  if (found === undefined) throw new Error(`no "${label}" button`);
  return found;
}

function enabledIn(scope: ParentNode, label: string): HTMLButtonElement[] {
  return buttonsIn(scope).filter(
    (button) => button.textContent?.includes(label) && !button.disabled,
  );
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

function field(id: string): HTMLTextAreaElement {
  const el = document.getElementById(id) as HTMLTextAreaElement | null;
  if (el === null) throw new Error(`no field #${id}`);
  return el;
}

function typeInto(id: string, value: string) {
  const el = field(id);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  if (setter === undefined) throw new Error("no native value setter");
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function saves(): { method: string; path: string; body: unknown }[] {
  return requested.filter(
    (entry) => entry.method === "PUT" && entry.path === BASE,
  );
}

function versionTable(el: ParentNode): HTMLTableElement {
  const table = el.querySelector<HTMLTableElement>(
    'table[aria-label="Versions"]',
  );
  if (table === null) throw new Error("no version table");
  return table;
}

describe("SkillDetailPage", () => {
  test("renders the editor seeded from the published version, with its pins", async () => {
    const el = await mount();
    expect(field("skill-body").value).toBe(HEAD_BODY);
    expect(el.textContent).toContain("Research Buddy");
  });

  test("the version list renders each commit's note, author, and when", async () => {
    const el = await mount();
    const table = versionTable(el);
    expect(table.textContent).toContain("Create triage");
    expect(table.textContent).toContain("Grace");
    expect(table.textContent).toContain("Version 1");
    expect(table.textContent).toContain("current");
  });

  test("Save… is offered only once the editor differs from the published version", async () => {
    const el = await mount();
    const bar = el.querySelector('[data-testid="stage-top-bar-actions"]');
    if (bar === null) throw new Error("no action slot");
    expect(buttonNamed(bar, "Save…").disabled).toBe(true);

    await act(async () => {
      typeInto("skill-body", `${HEAD_BODY}\nEscalate anything on fire.`);
    });
    expect(buttonNamed(bar, "Save…").disabled).toBe(false);
  });

  test("Save… opens a confirmation showing the diff, and writes nothing yet", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));

    expect(document.body.textContent).toContain("Review this save");
    const diff = document.body.querySelector('[data-testid="diff-view"]');
    expect(diff?.textContent).toContain("Pick one label.");
    expect(diff?.textContent).toContain("Pick two labels.");
    expect(saves()).toHaveLength(0);
  });

  test("Keep editing closes the review with the edit intact and nothing written", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Keep editing"));

    expect(document.body.textContent).not.toContain("Review this save");
    expect(saves()).toHaveLength(0);
    expect(field("skill-body").value).toBe(
      "Read the report.\nPick two labels.",
    );
  });

  test("Confirm & save publishes the new version against the version it reviewed", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nPick two labels.");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Confirm & save"));

    expect(saves()).toHaveLength(1);
    expect(saves()[0]?.body).toEqual({
      description: "Sorts inbound issues.",
      body: "Read the report.\nPick two labels.",
      expectedHeadSha: HEAD_SHA,
    });
  });

  test("a description edit is saved exactly as reviewed, untrimmed", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-description", "  Sorts inbound issues by severity.  ");
    });
    await click(buttonNamed(el, "Save…"));
    const diff = document.body.querySelector('[data-testid="diff-view"]');
    expect(diff?.textContent).toContain("Sorts inbound issues by severity.");
    await click(buttonNamed(document.body, "Confirm & save"));

    expect(saves()[0]?.body).toEqual({
      description: "  Sorts inbound issues by severity.  ",
      body: HEAD_BODY,
      expectedHeadSha: HEAD_SHA,
    });
  });

  test("CRLF in the buffer neither reads as a change nor changes the bytes saved", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\r\nPick one label.");
    });
    // Same text, different newline convention: nothing to save.
    const bar = el.querySelector('[data-testid="stage-top-bar-actions"]');
    if (bar === null) throw new Error("no action slot");
    expect(buttonNamed(bar, "Save…").disabled).toBe(true);

    await act(async () => {
      typeInto("skill-body", "Read the report.\r\nPick two labels.\r");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Confirm & save"));
    expect(saves()[0]?.body).toEqual({
      description: "Sorts inbound issues.",
      body: "Read the report.\nPick two labels.\n",
      expectedHeadSha: HEAD_SHA,
    });
  });

  test("a save that lost the race is refused, re-diffed against the version that won, and never buries it", async () => {
    const theirBody = "Read the report.\nPick one label.\nTheir new line.";
    const theirSha = "9999999999";
    stubs[`PUT ${BASE}`] = [
      { status: 409, body: { error: { message: "conflict" } } },
      ok({ skill: SKILL }),
    ];
    stubs[`GET ${BASE}`] = [
      ok({ skill: SKILL, pinnedBy: [] }),
      ok({ skill: { ...SKILL, body: theirBody }, pinnedBy: [] }),
    ];
    stubs[`GET ${BASE}/versions`] = [
      ok({ versions: VERSIONS }),
      ok({
        versions: [
          {
            commitSha: theirSha,
            message: "Update triage",
            author: "Grace",
            committedAtIso: "2026-08-05T11:30:00.000Z",
            current: true,
          },
          { ...VERSIONS[0], current: false },
        ],
      }),
    ];

    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nMy new line.");
    });
    await click(buttonNamed(el, "Save…"));
    await click(buttonNamed(document.body, "Confirm & save"));

    // The review is still open, saying what happened, now diffing against
    // the version that actually won the race.
    expect(document.body.textContent).toContain("Review this save");
    const notice = document.body.querySelector(
      '[data-testid="save-stale-notice"]',
    );
    expect(notice?.textContent).toContain("Someone else saved this skill");
    const diff = document.body.querySelector('[data-testid="diff-view"]');
    expect(diff?.textContent).toContain("Their new line.");
    expect(diff?.textContent).toContain("My new line.");
    // The edit is untouched and nothing was written.
    expect(field("skill-body").value).toBe("Read the report.\nMy new line.");
    expect(saves()).toHaveLength(1);

    // Confirming again saves on top of their version, naming it.
    await click(buttonNamed(document.body, "Confirm & save"));
    expect(saves()).toHaveLength(2);
    expect(saves()[1]?.body).toEqual({
      description: "Sorts inbound issues.",
      body: "Read the report.\nMy new line.",
      expectedHeadSha: theirSha,
    });
  });

  test("Compare reads the chosen version and diffs it against the current one", async () => {
    const el = await mount();
    const compares = enabledIn(versionTable(el), "Compare");
    expect(compares).toHaveLength(1);
    await click(compares[0] as HTMLButtonElement);

    expect(
      requested.some((entry) => entry.path === `${BASE}/versions/${OLDER_SHA}`),
    ).toBe(true);
    expect(el.textContent).toContain("compared with the current version");
    expect(el.textContent).toContain("Pick one label.");
  });

  test("Restore posts the chosen commit to the registry", async () => {
    const el = await mount();
    const restores = enabledIn(versionTable(el), "Restore");
    expect(restores).toHaveLength(1);
    await click(restores[0] as HTMLButtonElement);

    const call = requested.find((entry) => entry.path === `${BASE}/restore`);
    expect(call?.method).toBe("POST");
    expect(call?.body).toEqual({ commitSha: OLDER_SHA });
  });

  test("a restore keeps unsaved edits rather than silently discarding them", async () => {
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nMy unsaved edit.");
    });
    await click(enabledIn(versionTable(el), "Restore")[0] as HTMLButtonElement);
    expect(field("skill-body").value).toBe(
      "Read the report.\nMy unsaved edit.",
    );
  });

  test("a failed side action stays local: the editor and the edit survive", async () => {
    stubs[`PUT ${BASE}/scope`] = {
      status: 500,
      body: { error: { message: "hub is down" } },
    };
    const el = await mount();
    await act(async () => {
      typeInto("skill-body", "Read the report.\nMy unsaved edit.");
    });
    await click(buttonNamed(el, "Share with workbench"));

    expect(el.textContent).not.toContain("Couldn't load this skill");
    expect(el.textContent).not.toContain("hub is down");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Something went wrong",
    );
    expect(field("skill-body").value).toBe(
      "Read the report.\nMy unsaved edit.",
    );
  });

  test("a compare that fails reports itself without replacing the page", async () => {
    stubs[`GET ${BASE}/versions/${OLDER_SHA}`] = {
      status: 500,
      body: { error: { message: "hub is down" } },
    };
    const el = await mount();
    await click(enabledIn(versionTable(el), "Compare")[0] as HTMLButtonElement);

    expect(el.textContent).not.toContain("Couldn't load this skill");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      "Something went wrong",
    );
    expect(document.getElementById("skill-body")).not.toBeNull();
  });

  test("a skill that isn't there says so, rather than reporting a failure", async () => {
    stubs = {};
    const el = await mount();
    expect(el.textContent).toContain(`No skill named “${NAME}”`);
    expect(el.textContent).not.toContain("Couldn't load this skill");
  });

  test("a failed read says so in plain language, never the server's own words", async () => {
    stubs[`GET ${BASE}`] = {
      status: 503,
      body: { error: { message: "registry is down" } },
    };
    const el = await mount();
    expect(el.textContent).toContain("Couldn't load this skill");
    expect(el.textContent).not.toContain("registry is down");
  });

  test("a change too large to show line by line falls back to a summary", async () => {
    const el = await mount();
    const huge = Array.from(
      { length: 4_000 },
      (_, index) => `rewritten line ${String(index)}`,
    ).join("\n");
    await act(async () => {
      typeInto("skill-body", huge);
    });
    await click(buttonNamed(el, "Save…"));

    const summary = document.body.querySelector(
      '[data-testid="diff-too-large"]',
    );
    expect(summary?.textContent).toContain("too large to show line by line");
    expect(document.body.querySelector('[data-testid="diff-view"]')).toBeNull();
    // Still a real save: the review refuses to draw the diff, not the save.
    await click(buttonNamed(document.body, "Confirm & save"));
    expect(saves()).toHaveLength(1);
  });
});
