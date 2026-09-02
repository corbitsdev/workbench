// CL-6628 flips the picker's hierarchy: a prompt box is the primary act,
// with the prefab cards (still real template instantiation, CL-6342/
// CL-6344) demoted to one-click shortcuts underneath — no radio-then-
// Create two-step. These pin: the prompt box is what's on screen and
// autofocused, submitting it creates a blank workbench and delivers the
// typed text as the person's own first message, and a prefab card click
// still instantiates its template exactly like the old "Create workbench"
// button did.

import { afterEach, describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
  serializeWorkbenchDefinition,
} from "@workbench/templates";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { BenchProvider } from "../src/bench-context";
import { NavigationProvider } from "../src/navigation";
import { NewWorkbenchPickerRoute } from "../src/pages/new-workbench-picker";
import { TestQueryProvider } from "./test-query-provider";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MEMBERSHIP = {
  data: [
    {
      principalId: "prn_1",
      tenantId: "tnt_1",
      tenantName: "Corbits Bench",
      tenantSlug: "corbits-bench",
      kind: "user",
      status: "active",
      roles: [],
    },
  ],
  nextCursor: null,
};

type RecordedCall = { readonly path: string; readonly init?: RequestInit };

function stubFetch(
  extra: (path: string, init?: RequestInit) => Response | undefined,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = typeof input === "string" ? input : String(input);
    calls.push(init === undefined ? { path } : { path, init });
    if (path.includes("/api/me/principals")) {
      return Promise.resolve(json(MEMBERSHIP));
    }
    // The bench library the first read converges (CL-6458) — what the
    // picker offers cards from and the create flow instantiates from,
    // never a hardcoded import.
    if (path.endsWith("/library/templates")) {
      return Promise.resolve(
        json({
          data: [
            {
              id: "code-review",
              content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
            },
          ],
        }),
      );
    }
    if (path.endsWith("/library/templates/code-review")) {
      return Promise.resolve(
        json({
          id: "code-review",
          content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
        }),
      );
    }
    const response = extra(path, init);
    if (response !== undefined) return Promise.resolve(response);
    throw new Error(`unexpected fetch: ${path}`);
  }) as typeof fetch;
  return calls;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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

async function renderPicker(
  navigate: (to: string) => void = () => undefined,
): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TestQueryProvider>
        <NavigationProvider navigate={navigate}>
          <BenchProvider>
            <NewWorkbenchPickerRoute />
          </BenchProvider>
        </NavigationProvider>
      </TestQueryProvider>,
    );
  });
  for (let i = 0; i < 20; i++) {
    await settle();
    if (container.querySelector(".new-workbench-prompt-input") !== null) break;
  }
}

function promptInput(): HTMLTextAreaElement | null {
  return container?.querySelector(".new-workbench-prompt-input") ?? null;
}

// Setting `.value` directly on a React-controlled element doesn't trip
// its value tracker, so a plain `input` event dispatched right after is a
// no-op — the same native-setter workaround `form-block.test.tsx` and
// `connect-github-block.test.tsx` use for the same reason.
function typeIntoPrompt(value: string): void {
  const input = promptInput();
  if (input === null) return;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Only the clickable (offered) cards — a template the library can't
 * serve renders as a disabled `<span>` with the same class, never a
 * `<button>`, so this selector alone tells offered apart from
 * unavailable. */
function prefabCards(): HTMLButtonElement[] {
  return Array.from(
    container?.querySelectorAll<HTMLButtonElement>(
      "button.new-workbench-prefab-card",
    ) ?? [],
  );
}

/** The standard fixture for a create that mints against `blank` (no
 * manifest, no participants, no settings patch) — shared by every test
 * exercising the prompt box's blank-plus-first-message path. */
function stubBlankCreate(
  onSendMessage?: (body: { parts: readonly { kind: string }[] }) => void,
): RecordedCall[] {
  return stubFetch((path, init) => {
    if (path.includes("/workflows/definitions")) {
      return json({
        data: [
          {
            id: "wfd_assistant",
            tenantId: "tnt_1",
            name: "assistant",
            currentVersion: "1",
            status: "deployed",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        nextCursor: null,
      });
    }
    if (path.endsWith("/chat/workbenches") && init?.method === "POST") {
      return json({
        id: "chan_new",
        title: "New Workbench",
        kind: "workbench",
        pinned: false,
        participants: [],
      });
    }
    if (
      path.endsWith("/chat/workbenches/chan_new/messages") &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(String(init.body)) as {
        parts: readonly { kind: string }[];
      };
      onSendMessage?.(body);
      return json({ id: "msg_1", createdAt: "2026-01-01T00:00:00.000Z" });
    }
    if (
      path.endsWith("/chat/workbenches/chan_new/settings") &&
      init?.method === "PATCH"
    ) {
      return json({
        id: "chan_new",
        title: "Get our onboarding docs into shape",
        kind: "workbench",
        pinned: false,
        participants: [],
        settings: {},
        contextWindow: { value: 0, source: "inherit" },
      });
    }
    return undefined;
  });
}

describe("NewWorkbenchPickerRoute", () => {
  test("the prompt box is on screen, autofocused, with its placeholder", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    const input = promptInput();
    expect(input).not.toBeNull();
    expect(input?.placeholder).toBe("What do you want your Workbench to do?");
    expect(document.activeElement).toBe(input);
  });

  test("the prefab cards render below the prompt box, one click each — no radio group", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    expect(container?.querySelector('[role="radiogroup"]')).toBeNull();
    expect(container?.querySelector('[role="radio"]')).toBeNull();

    const cards = prefabCards();
    expect(cards.length).toBe(2);
    expect(container?.textContent).toContain("Code review");
    expect(container?.textContent).toContain("Just start talking");
    expect(container?.textContent).toContain(
      "An empty channel. Nobody is hosted.",
    );
  });

  // The library seeds every shipped template (`createTemplateLibrarySeeder`),
  // so a bench whose library serves due-diligence too offers it as a real
  // card, not just an entry in the static catalog with nothing to back it.
  test("due-diligence is offered as a card once the library serves it", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals")) {
        return Promise.resolve(json(MEMBERSHIP));
      }
      if (path.endsWith("/library/templates")) {
        return Promise.resolve(
          json({
            data: [
              {
                id: "code-review",
                content: serializeWorkbenchDefinition(CODE_REVIEW_TEMPLATE),
              },
              {
                id: "due-diligence",
                content: serializeWorkbenchDefinition(DUE_DILIGENCE_TEMPLATE),
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    await renderPicker();

    const cards = prefabCards();
    expect(cards.length).toBe(3);
    const dueDiligence = cards.find((card) =>
      card.textContent?.includes("Due Diligence"),
    );
    expect(dueDiligence).not.toBeUndefined();
    expect(dueDiligence?.textContent).toContain(
      "Scout checks a company, deal, or vendor",
    );
  });

  // CL-6458: the picker offers what the bench's library can actually
  // serve. A kind the library has no manifest for is shown as not set up
  // — never offered and then dead-ended on a 404 at create time.
  test("a kind this bench's library cannot serve is not offered as a live card", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals")) {
        return Promise.resolve(json(MEMBERSHIP));
      }
      if (path.endsWith("/library/templates")) {
        return Promise.resolve(json({ data: [] }));
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    await renderPicker();

    const cards = prefabCards();
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain("Just start talking");
    expect(container?.textContent).toContain("Code review");
    expect(container?.textContent).toContain("Not set up on this bench yet");
  });

  test("when the library can't be read, the screen says so instead of offering a dead end", async () => {
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = typeof input === "string" ? input : String(input);
      if (path.includes("/api/me/principals")) {
        return Promise.resolve(json(MEMBERSHIP));
      }
      if (path.endsWith("/library/templates")) {
        return Promise.resolve(json({ error: "boom" }, 503));
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    await renderPicker();

    expect(container?.textContent).toContain(
      "Couldn't load what this bench can set up",
    );
    expect(prefabCards().length).toBe(1);
    expect(prefabCards()[0]?.textContent).toContain("Just start talking");
  });

  test("typing a goal and hitting Enter creates a blank workbench and delivers the goal as the first message", async () => {
    let sentParts: readonly { kind: string; text?: string }[] = [];
    const calls = stubBlankCreate((body) => {
      sentParts = body.parts as typeof sentParts;
    });
    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    await act(async () => {
      typeIntoPrompt("Get our onboarding docs into shape");
    });
    await act(async () => {
      promptInput()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w/chan_new"]);

    const createWorkbenchCall = calls.find(
      (call) =>
        call.path.endsWith("/chat/workbenches") && call.init?.method === "POST",
    );
    expect(JSON.parse(String(createWorkbenchCall?.init?.body))).toMatchObject({
      kind: "workbench",
    });
    expect(
      JSON.parse(String(createWorkbenchCall?.init?.body)).definitionId,
    ).toBeUndefined();

    const sendMessageCall = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan_new/messages"),
    );
    expect(sendMessageCall).not.toBeUndefined();
    expect(sentParts).toEqual([
      { kind: "text", text: "Get our onboarding docs into shape" },
    ]);
  });

  test("Shift+Enter does not submit — the prompt box stays open for a new line", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    await act(async () => {
      typeIntoPrompt("line one");
    });
    await act(async () => {
      promptInput()?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    await settle();

    expect(container?.querySelector(".chat-workbench-loading")).toBeNull();
    expect(promptInput()?.value).toBe("line one");
  });

  test("submitting an empty prompt does nothing", async () => {
    stubFetch(() => undefined);
    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    await act(async () => {
      promptInput()?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();

    expect(navigated).toEqual([]);
  });

  // CL-6510: a bench whose default agents haven't finished deploying yet
  // (CL-6457's background drain still running, or never started without a
  // credential) must never dead-end the person on the raw internal
  // precondition message — the picker checks readiness first and shows an
  // honest, retryable "still setting up" state instead.
  test("when the setup agent isn't deployed yet, creating shows an honest still-setting-up state, not the raw precondition error", async () => {
    stubFetch((path) => {
      if (path.includes("/workflows/definitions")) {
        return json({ data: [], nextCursor: null });
      }
      if (path.endsWith("/api/onboarding/provisioning-status")) {
        return json({
          kind: "provisioning",
          tenantId: "tnt_1",
          tenantSlug: "corbits-bench",
          setupAgentReady: false,
          deployed: [],
          pending: ["assistant"],
        });
      }
      return undefined;
    });
    await renderPicker();

    const justTalk = prefabCards().find((card) =>
      card.textContent?.includes("Just start talking"),
    );
    await act(async () => {
      justTalk?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (container?.textContent?.includes("Still setting up")) break;
    }

    expect(container?.textContent).toContain("Still setting up your workbench");
    expect(container?.textContent).not.toContain(
      "No default setup agent found",
    );
  });

  test("clicking the Code review card mints a workbench from the template, then navigates in", async () => {
    const createdAgentHandles: string[] = [];
    const calls = stubFetch((path, init) => {
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tnt_1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/workbenches") && init?.method === "POST") {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (
        path.endsWith("/template-blocks/code-review/deploy") &&
        init?.method === "POST"
      ) {
        return json({ id: "wfd_code_review", created: true }, 201);
      }
      if (path.endsWith("/agent-definitions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { handle: string };
        createdAgentHandles.push(body.handle);
        return json({
          id: `wfd_${body.handle}`,
          tenantId: "tnt_1",
          name: body.handle,
          currentVersion: "1",
          status: "deployed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          skills: [],
        });
      }
      if (
        path.endsWith("/chat/workbenches/chan_new/invite") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as {
          definitionId: string;
        };
        return json({
          address: `${body.definitionId}@chan_new`,
          definitionId: body.definitionId,
        });
      }
      if (
        path.endsWith("/chat/workbenches/chan_new/onboarding") &&
        init?.method === "POST"
      ) {
        return json({ id: "msg_onboarding" }, 201);
      }
      if (path.endsWith("/chat/workbenches/chan_new/settings")) {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {
            "template/id": "code-review",
            "template/pendingConnections": ["github"],
          },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      return undefined;
    });

    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    const codeReview = prefabCards().find((card) =>
      card.textContent?.includes("Code review"),
    );
    await act(async () => {
      codeReview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w/chan_new"]);

    const createWorkbenchCall = calls.find(
      (call) =>
        call.path.endsWith("/chat/workbenches") && call.init?.method === "POST",
    );
    expect(JSON.parse(String(createWorkbenchCall?.init?.body))).toMatchObject({
      kind: "workbench",
    });
    expect(
      JSON.parse(String(createWorkbenchCall?.init?.body)).definitionId,
    ).toBeUndefined();

    expect(createdAgentHandles).toEqual([
      "correctness-reviewer",
      "architecture-reviewer",
      "release-risk-reviewer",
    ]);

    // CL-6405: instantiation also deploys the manifest's referenced
    // code-review block workflow, not just the reviewer roster.
    const blockDeploy = calls.find(
      (call) =>
        call.path.endsWith("/template-blocks/code-review/deploy") &&
        call.init?.method === "POST",
    );
    expect(blockDeploy).not.toBeUndefined();

    const settingsPatch = calls.find((call) =>
      call.path.endsWith("/chat/workbenches/chan_new/settings"),
    );
    expect(JSON.parse(String(settingsPatch?.init?.body))).toEqual({
      "template/id": "code-review",
      "template/pendingConnections": ["github"],
    });
  });

  // The in-room card is the one walkthrough: /new never opens a repo
  // dialog of its own, connected or not.
  test("clicking the Code review card opens no repo dialog — the walkthrough card owns repo pick", async () => {
    stubFetch((path, init) => {
      if (path.includes("/workflows/definitions")) {
        return json({
          data: [
            {
              id: "wfd_assistant",
              tenantId: "tnt_1",
              name: "assistant",
              currentVersion: "1",
              status: "deployed",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        });
      }
      if (path.endsWith("/chat/workbenches") && init?.method === "POST") {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "workbench",
          pinned: false,
          participants: [],
        });
      }
      if (
        path.endsWith("/template-blocks/code-review/deploy") &&
        init?.method === "POST"
      ) {
        return json({ id: "wfd_code_review", created: true }, 201);
      }
      if (path.endsWith("/agent-definitions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { handle: string };
        return json({
          id: `wfd_${body.handle}`,
          tenantId: "tnt_1",
          name: body.handle,
          currentVersion: "1",
          status: "deployed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          skills: [],
        });
      }
      if (
        path.endsWith("/chat/workbenches/chan_new/invite") &&
        init?.method === "POST"
      ) {
        const body = JSON.parse(String(init.body)) as {
          definitionId: string;
        };
        return json({
          address: `${body.definitionId}@chan_new`,
          definitionId: body.definitionId,
        });
      }
      if (
        path.endsWith("/chat/workbenches/chan_new/onboarding") &&
        init?.method === "POST"
      ) {
        return json({ id: "msg_onboarding" }, 201);
      }
      if (path.endsWith("/chat/workbenches/chan_new/settings")) {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "workbench",
          pinned: false,
          participants: [],
          settings: {
            "template/id": "code-review",
            "template/pendingConnections": ["github"],
          },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      return undefined;
    });

    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    const codeReview = prefabCards().find((card) =>
      card.textContent?.includes("Code review"),
    );
    await act(async () => {
      codeReview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    for (let i = 0; i < 20; i++) {
      await settle();
      if (navigated.length > 0) break;
    }

    expect(navigated).toEqual(["/w/chan_new"]);
    expect(document.body.textContent).not.toContain(
      "Choose repos this workbench can work on",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some((button) =>
        button.textContent?.startsWith("Start reviewing"),
      ),
    ).toBe(false);
  });
});
