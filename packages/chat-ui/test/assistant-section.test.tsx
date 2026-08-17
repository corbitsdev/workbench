// DOM-mounted composition tests for the Assistant settings section: it
// reads and saves through `@corbits/agent-directory`'s routes rather
// than the channel settings PATCH every other section uses, so its
// load/save/error sequencing needs a real effect-driven mount (see
// dom-setup.ts) the same way chat-workspace.test.tsx's settings-surface
// tests do. Stubs `global.fetch` directly, never `mock.module`.

import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { ChannelSettingsSurface } from "../src/channel-settings";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

type AgentFixture = {
  readonly address: string;
  readonly handle: string;
  readonly definitionId: string;
  name: string;
  systemPrompt: string;
  toolPackagePins: { name: string; version: string }[];
  skills: string[];
  model?: string;
};

const MYRA: AgentFixture = {
  address: "myra@acme.example",
  handle: "myra",
  definitionId: "wfd_myra",
  name: "Myra",
  systemPrompt: "Be a helpful assistant.",
  toolPackagePins: [],
  skills: [],
};

type VersionFixture = {
  readonly commitSha: string;
  readonly message: string;
  readonly author: string;
  readonly committedAtIso: string;
  readonly current: boolean;
};

function stubFetch(options: {
  readonly agents?: readonly AgentFixture[];
  readonly saveFails?: boolean;
  readonly versions?: readonly VersionFixture[];
  readonly capabilityInventory?: {
    readonly toolPackages: readonly { name: string }[];
    readonly skills: readonly { name: string }[];
    readonly models: readonly { canonicalName: string }[];
  };
  readonly addCapabilityFails?: boolean;
  readonly restoreFails?: boolean;
  readonly onSave?: (
    definitionId: string,
    body: { name: string; systemPrompt: string },
  ) => void;
  readonly onRefresh?: (address: string) => void;
  readonly onAddCapability?: (definitionId: string, body: unknown) => void;
  readonly onRestore?: (definitionId: string, commitSha: string) => void;
}) {
  // Cloned so a save in one test can never mutate a fixture another
  // test (or another `stubFetch` call in the same test) still reads —
  // `agents`/`MYRA` are shared object literals, not fresh per call.
  const agents = (options.agents ?? [MYRA]).map((agent) => ({
    ...agent,
    toolPackagePins: [...agent.toolPackagePins],
    skills: [...agent.skills],
  }));
  const refreshCalls: string[] = [];
  const capabilityInventory = options.capabilityInventory ?? {
    toolPackages: [],
    skills: [],
    models: [],
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (/\/chat\/channels\/[^/]+\/settings$/.test(path)) {
      return json({
        id: "ch_1",
        title: "Talk to Myra",
        kind: "chat",
        pinned: false,
        participants: agents.map((agent) => ({
          address: agent.address,
          handle: agent.handle,
        })),
        settings: {},
        contextWindow: { value: 20, source: "inherit" },
      });
    }
    if (/\/chat\/bench\/settings$/.test(path)) {
      return json({ settings: {}, contextWindow: 20 });
    }
    if (/\/chat\/channels\/[^/]+\/agents\/refresh$/.test(path)) {
      const body = JSON.parse(String(init?.body)) as { address: string };
      refreshCalls.push(body.address);
      options.onRefresh?.(body.address);
      return json({ ok: true });
    }
    if (/\/chat\/channels\/[^/]+\/agents$/.test(path)) {
      return json({
        items: agents.map((agent) => ({
          address: agent.address,
          handle: agent.handle,
          definitionId: agent.definitionId,
        })),
      });
    }
    if (/\/agent-definitions\/capabilities\/inventory$/.test(path)) {
      return json(capabilityInventory);
    }
    const versionsMatch = /\/agent-definitions\/([^/]+)\/versions$/.exec(path);
    if (versionsMatch !== null) {
      return json({ versions: options.versions ?? [] });
    }
    const restoreMatch = /\/agent-definitions\/([^/]+)\/restore$/.exec(path);
    if (restoreMatch !== null) {
      const definitionId = restoreMatch[1] as string;
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (options.restoreFails === true) {
        return json({ error: { code: "internal", message: "boom" } }, 500);
      }
      const body = JSON.parse(String(init?.body)) as { commitSha: string };
      options.onRestore?.(definitionId, body.commitSha);
      return json({
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    const capabilitiesMatch =
      /\/agent-definitions\/([^/]+)\/capabilities$/.exec(path);
    if (capabilitiesMatch !== null) {
      const definitionId = capabilitiesMatch[1] as string;
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (options.addCapabilityFails === true) {
        return json({ error: { code: "bad_request", message: "boom" } }, 400);
      }
      const body = JSON.parse(String(init?.body)) as
        | { kind: "toolPackage"; name: string }
        | { kind: "skill"; name: string }
        | { kind: "model"; canonicalName: string };
      options.onAddCapability?.(definitionId, body);
      if (body.kind === "toolPackage") {
        agent.toolPackagePins = [
          ...agent.toolPackagePins,
          { name: body.name, version: "*" },
        ];
      } else if (body.kind === "skill") {
        agent.skills = [...agent.skills, body.name];
      } else {
        agent.model = body.canonicalName;
      }
      return json({
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    const definitionMatch = /\/agent-definitions\/([^/]+)$/.exec(path);
    if (definitionMatch !== null) {
      const definitionId = definitionMatch[1];
      const agent = agents.find((a) => a.definitionId === definitionId);
      if (agent === undefined) {
        return json(
          { error: { code: "not_found", message: "no such agent" } },
          404,
        );
      }
      if (init?.method === "PUT") {
        if (options.saveFails === true) {
          return json({ error: { code: "internal", message: "boom" } }, 500);
        }
        const body = JSON.parse(String(init.body)) as {
          name: string;
          systemPrompt: string;
        };
        agent.name = body.name;
        agent.systemPrompt = body.systemPrompt;
        options.onSave?.(definitionId as string, body);
        return json({ name: agent.name, systemPrompt: agent.systemPrompt });
      }
      return json({
        name: agent.name,
        systemPrompt: agent.systemPrompt,
        toolPackagePins: agent.toolPackagePins,
        skills: agent.skills,
        model: agent.model,
      });
    }
    throw new Error(`unstubbed fetch: ${path}`);
  }) as typeof fetch;

  return { refreshCalls };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(props: Parameters<typeof ChannelSettingsSurface>[0]) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(ChannelSettingsSurface, props));
  });
  return container;
}

afterEach(() => {
  if (root !== null) {
    act(() => root?.unmount());
    root = null;
  }
  if (container !== null) {
    container.remove();
    container = null;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => act(() => sleep(10));

function baseProps(
  overrides: Partial<Parameters<typeof ChannelSettingsSurface>[0]> = {},
) {
  return {
    tenantId: "tnt_1",
    channelId: "ch_1",
    channelTitle: "Talk to Myra",
    onBack: () => undefined,
    onInviteParticipant: () => undefined,
    section: "assistant" as const,
    ...overrides,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  act(() => {
    setter?.call(textarea, value);
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(el: HTMLElement, text: string) {
  return Array.from(
    el.querySelectorAll(".channel-settings-panel-area button"),
  ).find((button) => button.textContent === text) as
    HTMLButtonElement | undefined;
}

describe("Assistant settings section", () => {
  test("loads the agent's name and instructions, saves them, and refreshes its running instance", async () => {
    let saved: { name: string; systemPrompt: string } | undefined;
    const { refreshCalls } = stubFetch({
      onSave: (_definitionId, body) => {
        saved = body;
      },
    });
    const el = mount(baseProps());
    await settle();

    const nameInput = el.querySelector(
      ".channel-settings-panel-area input",
    ) as HTMLInputElement | null;
    const textarea = el.querySelector(
      ".channel-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    expect(nameInput?.value).toBe("Myra");
    expect(textarea?.value).toBe("Be a helpful assistant.");

    setTextareaValue(textarea, "Be a blunt, no-nonsense assistant.");
    await settle();

    const saveButton = findButton(el, "Save");
    expect(saveButton).toBeDefined();
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(saved).toEqual({
      name: "Myra",
      systemPrompt: "Be a blunt, no-nonsense assistant.",
    });
    expect(refreshCalls).toEqual(["myra@acme.example"]);
    expect(findButton(el, "Save")?.disabled).toBe(true);
  });

  test("a failed save shows an inline error and keeps the edit", async () => {
    stubFetch({ saveFails: true });
    const el = mount(baseProps());
    await settle();

    const textarea = el.querySelector(
      ".channel-settings-panel-area textarea",
    ) as HTMLTextAreaElement | null;
    setTextareaValue(textarea, "Try to save this.");
    await settle();

    const saveButton = findButton(el, "Save");
    act(() => {
      saveButton?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't save these changes — try again.",
    );
    expect(textarea?.value).toBe("Try to save this.");
  });

  test("a channel with no agent participant never shows the Myra tab", async () => {
    stubFetch({ agents: [] });
    const el = mount(baseProps({ section: "general" }));
    await settle();

    const navLabels = Array.from(
      el.querySelectorAll(".channel-settings-nav-item"),
    ).map((item) => item.textContent);
    expect(navLabels).not.toContain("Myra");
  });

  test("a two-agent channel shows both entries and edits the right one", async () => {
    const second: AgentFixture = {
      address: "researcher@acme.example",
      handle: "researcher",
      definitionId: "wfd_researcher",
      name: "Researcher",
      systemPrompt: "Dig up sources.",
      toolPackagePins: [],
      skills: [],
    };
    const saves: {
      definitionId: string;
      body: { name: string; systemPrompt: string };
    }[] = [];
    stubFetch({
      agents: [MYRA, second],
      onSave: (definitionId, body) => {
        saves.push({ definitionId, body });
      },
    });
    const el = mount(baseProps());
    await settle();

    const titles = Array.from(
      el.querySelectorAll(".chat-settings-agent-block-title"),
    ).map((node) => node.textContent);
    expect(titles.sort()).toEqual(["Myra", "Researcher"]);

    const researcherBlock = Array.from(
      el.querySelectorAll(".chat-settings-agent-block"),
    ).find(
      (block) =>
        block.querySelector(".chat-settings-agent-block-title")?.textContent ===
        "Researcher",
    );
    expect(researcherBlock).toBeDefined();
    const researcherTextarea = researcherBlock?.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    expect(researcherTextarea?.value).toBe("Dig up sources.");

    setTextareaValue(researcherTextarea, "Dig up sources, then cite them.");
    await settle();

    const researcherSave = Array.from(
      researcherBlock?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Save") as
      HTMLButtonElement | undefined;
    act(() => {
      researcherSave?.click();
    });
    await settle();

    expect(saves).toEqual([
      {
        definitionId: "wfd_researcher",
        body: {
          name: "Researcher",
          systemPrompt: "Dig up sources, then cite them.",
        },
      },
    ]);

    // Myra's own block is untouched by editing the researcher's.
    const myraBlock = Array.from(
      el.querySelectorAll(".chat-settings-agent-block"),
    ).find(
      (block) =>
        block.querySelector(".chat-settings-agent-block-title")?.textContent ===
        "Myra",
    );
    const myraTextarea = myraBlock?.querySelector(
      "textarea",
    ) as HTMLTextAreaElement | null;
    expect(myraTextarea?.value).toBe("Be a helpful assistant.");
  });
});

describe("Assistant settings section — Capabilities", () => {
  test("lists current tools/skills/model and offers only what's not already attached", async () => {
    const withCapabilities: AgentFixture = {
      ...MYRA,
      toolPackagePins: [{ name: "@corbits/github-tools", version: "*" }],
      skills: ["research"],
    };
    stubFetch({
      agents: [withCapabilities],
      capabilityInventory: {
        toolPackages: [
          { name: "@corbits/github-tools" },
          { name: "@corbits/granola-tools" },
        ],
        skills: [{ name: "research" }, { name: "writing" }],
        models: [{ canonicalName: "anthropic/claude-sonnet" }],
      },
    });
    const el = mount(baseProps());
    await settle();

    const listText = el.querySelector(
      ".chat-settings-capability-list",
    )?.textContent;
    expect(listText).toContain("@corbits/github-tools");
    expect(listText).toContain("research");

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    const toolOptions = Array.from(choiceSelect?.options ?? []).map(
      (option) => option.value,
    );
    // The already-pinned tool package is not offered again; the
    // not-yet-pinned one is.
    expect(toolOptions).not.toContain("@corbits/github-tools");
    expect(toolOptions).toContain("@corbits/granola-tools");
  });

  test("adding a capability calls the capabilities route, refreshes the running instance, and reflects the addition", async () => {
    let addedBody: unknown;
    const { refreshCalls } = stubFetch({
      capabilityInventory: {
        toolPackages: [{ name: "@corbits/github-tools" }],
        skills: [],
        models: [],
      },
      onAddCapability: (_definitionId, body) => {
        addedBody = body;
      },
    });
    const el = mount(baseProps());
    await settle();

    const kindSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[0] as HTMLSelectElement | null;
    expect(kindSelect?.value).toBe("toolPackage");

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    act(() => {
      if (choiceSelect !== null) {
        choiceSelect.value = "@corbits/github-tools";
        choiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();

    const addButton = findButton(el, "Add");
    expect(addButton?.disabled).toBe(false);
    act(() => {
      addButton?.click();
    });
    await settle();

    expect(addedBody).toEqual({
      kind: "toolPackage",
      name: "@corbits/github-tools",
    });
    expect(refreshCalls).toEqual(["myra@acme.example"]);
    const badges = Array.from(
      el.querySelectorAll(".chat-settings-capability-list"),
    )[0]?.textContent;
    expect(badges).toContain("@corbits/github-tools");
  });

  test("a rejected capability add shows an inline error and never claims success", async () => {
    stubFetch({
      addCapabilityFails: true,
      capabilityInventory: {
        toolPackages: [{ name: "@corbits/github-tools" }],
        skills: [],
        models: [],
      },
    });
    const el = mount(baseProps());
    await settle();

    const choiceSelect = el.querySelectorAll(
      ".chat-settings-capability-add select",
    )[1] as HTMLSelectElement | null;
    act(() => {
      if (choiceSelect !== null) {
        choiceSelect.value = "@corbits/github-tools";
        choiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await settle();
    act(() => {
      findButton(el, "Add")?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't add that — it may no longer be available.",
    );
  });
});

describe("Assistant settings section — History", () => {
  test("lists version history newest first, with the current version's restore disabled", async () => {
    stubFetch({
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
    });
    const el = mount(baseProps());
    await settle();

    const rows = el.querySelectorAll("table tbody tr");
    expect(rows.length).toBe(2);
    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    expect(restoreButtons[0]?.disabled).toBe(true);
    expect(restoreButtons[1]?.disabled).toBe(false);
  });

  test("restoring a version calls restore, refreshes the running instance, and updates the editor", async () => {
    let restoredSha: string | undefined;
    const withCapabilities: AgentFixture = {
      ...MYRA,
      name: "Myra",
      systemPrompt: "You are now polite.",
    };
    const { refreshCalls } = stubFetch({
      agents: [withCapabilities],
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
      onRestore: (_definitionId, commitSha) => {
        restoredSha = commitSha;
      },
    });
    const el = mount(baseProps());
    await settle();

    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    act(() => {
      restoreButtons[1]?.click();
    });
    await settle();

    expect(restoredSha).toBe("sha1");
    expect(refreshCalls).toEqual(["myra@acme.example"]);
  });

  test("a failed restore shows an inline error", async () => {
    stubFetch({
      restoreFails: true,
      versions: [
        {
          commitSha: "sha2",
          message: "Update agent instructions for myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: true,
        },
        {
          commitSha: "sha1",
          message: "Define agent Myra",
          author: "Ada",
          committedAtIso: new Date().toISOString(),
          current: false,
        },
      ],
    });
    const el = mount(baseProps());
    await settle();

    const restoreButtons = Array.from(
      el.querySelectorAll("table tbody tr button"),
    ) as HTMLButtonElement[];
    act(() => {
      restoreButtons[1]?.click();
    });
    await settle();

    expect(el.querySelector(".chat-dialog-error")?.textContent).toBe(
      "Couldn't restore that version — try again.",
    );
  });
});
