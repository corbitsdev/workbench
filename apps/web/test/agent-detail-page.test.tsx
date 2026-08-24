// The agent detail page (CL-6414) at `/agents/<slug>`: the identity card,
// the system-prompt editor, the skills section, recent runs, and the
// Duplicate/Archive/Save trio in the top bar's action slot. Mounted against
// a stubbed hub so every edit is asserted where it matters — on the request
// body that leaves the page, through the mutations
// `@corbits/agent-directory` already owns, never a write path of this
// page's own.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentDetailPage,
  describeSaveReport,
  duplicateHandle,
  recentRunsForDefinition,
  type SaveReport,
} from "../src/pages/agent-detail-page";
import type { AgentDefinitionWithDisplayName } from "../src/agents-directory";
import type {
  AgentDefinitionDetail,
  AgentInstance,
  CatalogModel,
} from "../src/agents-api";

const definition: AgentDefinitionWithDisplayName = {
  id: "wfd_1",
  tenantId: "tnt_1",
  name: "triage-bot",
  displayName: "Triage bot",
  description: "Triage bot",
  currentVersion: "v1",
  status: "deployed",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const detail: AgentDefinitionDetail = {
  name: "Triage bot",
  systemPrompt: "You sort inbound issues.",
  model: "claude-sonnet",
  skills: ["triage"],
};

const models: readonly CatalogModel[] = [
  {
    id: "mdl_1",
    tenantId: "tnt_1",
    canonicalName: "claude-sonnet",
    displayName: "Claude Sonnet",
    disabled: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as CatalogModel,
  {
    id: "mdl_2",
    tenantId: "tnt_1",
    canonicalName: "claude-opus",
    displayName: "Claude Opus",
    disabled: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  } as unknown as CatalogModel,
];

function run(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: "run_1",
    definitionId: "wfd_1",
    definitionName: "triage-bot",
    tenantId: "tnt_1",
    address: "triage-bot@example.test",
    status: "running",
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...overrides,
  } as AgentInstance;
}

const noop = () => undefined;

function renderPage(
  props: Partial<Parameters<typeof AgentDetailPage>[0]> = {},
) {
  return renderToStaticMarkup(
    <AgentDetailPage
      tenantId="tnt_1"
      definition={definition}
      detail={detail}
      models={models}
      runs={[run()]}
      saveReport={null}
      onSaved={noop}
      onDuplicated={async () => undefined}
      onStatusChanged={noop}
      {...props}
    />,
  );
}

describe("recentRunsForDefinition", () => {
  test("keeps only this definition's runs, newest first", () => {
    const recent = recentRunsForDefinition(
      [
        run({ id: "run_old", createdAt: "2026-08-01T00:00:00.000Z" }),
        run({ id: "run_other", definitionId: "wfd_other" }),
        run({ id: "run_new", createdAt: "2026-08-20T00:00:00.000Z" }),
      ],
      "wfd_1",
    );
    expect(recent.map((entry) => entry.id)).toEqual(["run_new", "run_old"]);
  });
});

describe("duplicateHandle", () => {
  test("suffixes the original slug, staying kebab-safe", () => {
    expect(duplicateHandle("triage-bot")).toBe("triage-bot-copy");
  });
});

describe("AgentDetailPage render", () => {
  test("renders the slug immutably in mono beside the editable display name", () => {
    const markup = renderPage();
    expect(markup).toContain('id="agent-display-name"');
    expect(markup).toContain('value="Triage bot"');
    expect(markup).toContain("font-mono");
    expect(markup).toContain("triage-bot");
    expect(markup).not.toContain('id="agent-slug"');
  });

  test("crumbs read Agents → display name, linking back to the roster", () => {
    const markup = renderPage();
    expect(markup).toContain('href="/agents"');
    expect(markup).toContain("Triage bot");
  });

  test("puts Duplicate, Archive, and Save in the top bar's action slot", () => {
    const markup = renderPage();
    const actions =
      markup.split('data-testid="stage-top-bar-actions"')[1] ?? "";
    expect(actions).toContain('aria-label="Duplicate this agent"');
    expect(actions).toContain('aria-label="Archive this agent"');
    expect(actions).toContain('aria-label="Save this agent"');
  });

  test("an archived agent offers Restore instead of Archive", () => {
    const markup = renderPage({
      definition: { ...definition, status: "stopped" },
    });
    expect(markup).toContain('aria-label="Restore this agent"');
    expect(markup).not.toContain('aria-label="Archive this agent"');
    expect(markup).toContain("Archived");
  });

  test("offers the full system prompt in an editor seeded from the definition", () => {
    const markup = renderPage();
    expect(markup).toContain("System prompt");
    expect(markup).toContain("You sort inbound issues.");
  });

  test("lists the agent's own runs, each linking into the Insights run surface", () => {
    const markup = renderPage();
    expect(markup).toContain('href="/insights/runs/run_1"');
  });

  test("teaches what recent runs will hold when the agent has never run", () => {
    const markup = renderPage({ runs: [] });
    expect(markup).toContain("No runs yet");
  });

  test("offers no description field — a definition's description IS its display name", () => {
    const markup = renderPage();
    expect(markup).not.toContain('id="agent-description"');
  });

  // Same agent, one name everywhere: the page titles and seeds its name
  // field from `deriveDisplayName`, exactly like the roster row does, so a
  // definition with no description reads as its humanized slug on both.
  test("titles from the derived display name, never a second naming rule", () => {
    const markup = renderPage({
      definition: {
        ...definition,
        name: "research-analyst",
        displayName: "Research Analyst",
        description: null,
      },
      detail: { ...detail, name: "research-analyst" },
    });
    expect(markup).toContain('value="Research Analyst"');
    expect(markup).not.toContain('value="research-analyst"');
  });

  test("reports the outcome of the save that produced what is on screen", () => {
    const markup = renderPage({
      saveReport: {
        saved: ["instructions"],
        failed: { part: "skills", message: "The registry is unreachable." },
      },
    });
    expect(markup).toContain("name and system prompt");
    expect(markup).toContain("skills");
    expect(markup).toContain("The registry is unreachable.");
  });

  test("CL-6836: skillsError is an alert above Skills, never silent empty pins", () => {
    const markup = renderPage({ skillsError: "500: down" });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not load agent skills");
    expect(markup).toContain("500: down");
  });
});

describe("describeSaveReport", () => {
  test("a clean save names what it wrote", () => {
    expect(describeSaveReport({ saved: ["model"], failed: null })).toBe(
      "Saved default model.",
    );
  });

  test("a partial save names both halves, never just the failure", () => {
    const sentence = describeSaveReport({
      saved: ["instructions"],
      failed: { part: "model", message: "Something went wrong." },
    });
    expect(sentence).toContain("Saved name and system prompt");
    expect(sentence).toContain("default model");
  });
});

// --- Edits round-tripping through the API ---

const realFetch = globalThis.fetch;
let requests: { method: string; url: string; body: unknown }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body =
      init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method: init?.method ?? "GET", url, body });
    if (url.endsWith("/skills") && (init?.method ?? "GET") === "GET") {
      return Promise.resolve(json({ skills: [] }));
    }
    if (url.includes("/skills?")) {
      return Promise.resolve(json({ data: [], nextCursor: null }));
    }
    if (url.endsWith("/skills")) {
      return Promise.resolve(json({ skills: ["triage"] }));
    }
    if (url.endsWith("/capabilities")) {
      return Promise.resolve(
        json({ skills: ["triage"], model: "claude-opus" }),
      );
    }
    if (url.endsWith("/status")) {
      return Promise.resolve(json({ id: "wfd_1", status: "stopped" }));
    }
    if (url.endsWith("/agent-definitions")) {
      return Promise.resolve(
        json(
          {
            id: "wfd_2",
            tenantId: "tnt_1",
            name: "triage-bot-copy",
            description: "Triage bot copy",
            currentVersion: "v1",
            status: "deployed",
            createdAt: "2026-08-20T00:00:00.000Z",
            updatedAt: "2026-08-20T00:00:00.000Z",
            skills: ["triage"],
          },
          201,
        ),
      );
    }
    return Promise.resolve(
      json({ name: "Triage bot", systemPrompt: "You sort inbound issues." }),
    );
  }) as typeof fetch;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  requests = [];
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  container?.remove();
  container = null;
});

async function mount(
  overrides: Partial<Parameters<typeof AgentDetailPage>[0]> = {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AgentDetailPage
        tenantId="tnt_1"
        definition={definition}
        detail={detail}
        models={models}
        runs={[run()]}
        saveReport={null}
        onSaved={noop}
        onDuplicated={async () => undefined}
        onStatusChanged={noop}
        {...overrides}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const setter = Object.getOwnPropertyDescriptor(
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function byLabel(node: HTMLElement, label: string): HTMLElement {
  const found = node.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (found === null) throw new Error(`no element labelled "${label}"`);
  return found;
}

describe("AgentDetailPage edits", () => {
  test("Save is inert until something actually changes", async () => {
    const node = await mount();
    const save = byLabel(node, "Save this agent") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  test("a renamed agent with a rewritten prompt saves through the instructions route", async () => {
    let saved = 0;
    const node = await mount({ onSaved: () => (saved += 1) });
    const name = node.querySelector<HTMLInputElement>("#agent-display-name");
    const prompt = node.querySelector<HTMLTextAreaElement>(
      "#agent-system-prompt",
    );
    if (name === null || prompt === null) throw new Error("editor not mounted");

    await act(async () => {
      setValue(name, "Inbox triage");
      setValue(prompt, "You sort inbound issues, briskly.");
    });
    await act(async () => {
      byLabel(node, "Save this agent").click();
      await Promise.resolve();
    });

    const put = requests.find(
      (request) =>
        request.method === "PUT" &&
        request.url === "/api/tenants/tnt_1/agent-definitions/wfd_1",
    );
    expect(put?.body).toEqual({
      name: "Inbox triage",
      systemPrompt: "You sort inbound issues, briskly.",
    });
    expect(saved).toBe(1);
  });

  test("a changed default model saves through the guided capability route, not a new one", async () => {
    const node = await mount();
    const select = node.querySelector<HTMLSelectElement>("#agent-model");
    if (select === null) throw new Error("model select not mounted");

    await act(async () => {
      select.value = "claude-opus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      byLabel(node, "Save this agent").click();
      await Promise.resolve();
    });

    const post = requests.find((request) =>
      request.url.endsWith("/agent-definitions/wfd_1/capabilities"),
    );
    expect(post?.body).toEqual({ kind: "model", canonicalName: "claude-opus" });
    // An untouched field is never rewritten.
    expect(
      requests.some(
        (request) =>
          request.url === "/api/tenants/tnt_1/agent-definitions/wfd_1" &&
          request.method === "PUT",
      ),
    ).toBe(false);
  });

  test("Duplicate creates a second definition from this one's authored state", async () => {
    const duplicated: string[] = [];
    const node = await mount({
      onDuplicated: async (slug: string) => {
        duplicated.push(slug);
      },
    });
    await act(async () => {
      byLabel(node, "Duplicate this agent").click();
      await Promise.resolve();
    });

    const post = requests.find(
      (request) => request.url === "/api/tenants/tnt_1/agent-definitions",
    );
    expect(post?.body).toEqual({
      name: "Triage bot copy",
      handle: "triage-bot-copy",
      systemPrompt: "You sort inbound issues.",
      model: "claude-sonnet",
      skills: ["triage"],
    });
    expect(duplicated).toEqual(["triage-bot-copy"]);
  });

  test("Archive takes two clicks and writes the stopped status, never a delete", async () => {
    let changed = 0;
    const node = await mount({ onStatusChanged: () => (changed += 1) });
    const archive = byLabel(node, "Archive this agent");

    await act(async () => {
      archive.click();
    });
    expect(requests.some((request) => request.url.endsWith("/status"))).toBe(
      false,
    );

    await act(async () => {
      archive.click();
      await Promise.resolve();
    });

    const put = requests.find((request) => request.url.endsWith("/status"));
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({ status: "stopped" });
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    expect(changed).toBe(1);
  });

  test("a failed save reports which part failed, so the caller can reload honestly", async () => {
    const reports: SaveReport[] = [];
    const node = await mount({
      onSaved: (report: SaveReport) => reports.push(report),
    });
    globalThis.fetch = (() =>
      Promise.resolve(
        json({ error: { message: "The agent is locked." } }, 500),
      )) as unknown as typeof fetch;
    const prompt = node.querySelector<HTMLTextAreaElement>(
      "#agent-system-prompt",
    );
    if (prompt === null) throw new Error("editor not mounted");

    await act(async () => {
      setValue(prompt, "New instructions.");
    });
    await act(async () => {
      byLabel(node, "Save this agent").click();
      await Promise.resolve();
    });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.saved).toEqual([]);
    expect(reports[0]?.failed?.part).toBe("instructions");
  });

  test("selecting Bench default on a pinned agent is a real edit that clears the model", async () => {
    const node = await mount();
    const select = node.querySelector<HTMLSelectElement>("#agent-model");
    if (select === null) throw new Error("model select not mounted");

    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const save = byLabel(node, "Save this agent") as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    const cleared = requests.find(
      (request) =>
        request.url ===
        "/api/tenants/tnt_1/agent-definitions/wfd_1/capabilities/model",
    );
    expect(cleared?.method).toBe("DELETE");
    // Never the inventory-checked add route with an empty name.
    expect(
      requests.some(
        (request) =>
          request.url.endsWith("/capabilities") &&
          (request.body as { canonicalName?: string } | undefined)
            ?.canonicalName === "",
      ),
    ).toBe(false);
  });

  test("a Save that lands partway names the parts that committed", async () => {
    const reports: SaveReport[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body =
        init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
      requests.push({ method: init?.method ?? "GET", url, body });
      if (url.endsWith("/capabilities")) {
        return Promise.resolve(json({ error: { message: "model gone" } }, 500));
      }
      if (url.endsWith("/skills")) return Promise.resolve(json({ skills: [] }));
      return Promise.resolve(
        json({ name: "Inbox triage", systemPrompt: "New instructions." }),
      );
    }) as unknown as typeof fetch;

    const node = await mount({
      onSaved: (report: SaveReport) => reports.push(report),
    });
    const prompt = node.querySelector<HTMLTextAreaElement>(
      "#agent-system-prompt",
    );
    const select = node.querySelector<HTMLSelectElement>("#agent-model");
    if (prompt === null || select === null) {
      throw new Error("editor not mounted");
    }

    await act(async () => {
      setValue(prompt, "New instructions.");
      select.value = "claude-opus";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {
      byLabel(node, "Save this agent").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(reports[0]?.saved).toEqual(["instructions"]);
    expect(reports[0]?.failed?.part).toBe("model");
    expect(describeSaveReport(reports[0] as SaveReport)).toContain(
      "name and system prompt",
    );
  });

  test("a duplicate whose handle already exists says what collided, never 'try again'", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-definitions")) {
        return Promise.resolve(
          json(
            {
              error: {
                code: "conflict",
                message:
                  'An agent with the handle "triage-bot-copy" already exists',
              },
            },
            409,
          ),
        );
      }
      return Promise.resolve(json({ skills: [] }));
    }) as unknown as typeof fetch;

    const node = await mount();
    await act(async () => {
      byLabel(node, "Duplicate this agent").click();
      await Promise.resolve();
    });

    expect(node.textContent).toContain("triage-bot-copy");
    expect(node.textContent).toContain("already exists");
    expect(node.textContent).not.toContain("Try again");
  });

  test("Duplicate waits for unsaved edits rather than silently copying the saved version", async () => {
    const node = await mount();
    const prompt = node.querySelector<HTMLTextAreaElement>(
      "#agent-system-prompt",
    );
    if (prompt === null) throw new Error("editor not mounted");

    await act(async () => {
      setValue(prompt, "Edited, not yet saved.");
    });

    const duplicate = byLabel(
      node,
      "Duplicate this agent",
    ) as HTMLButtonElement;
    expect(duplicate.disabled).toBe(true);
    expect(node.textContent).toContain("Duplicate copies the saved version");
  });
});
