// Screen 1 of the approved mock (CL-6342): a one-column row list — no card
// grid, no second "or start blank" branch. Every assertion here pins the
// mock's own spec note: a row is always selected on entry so "Create
// workbench" starts enabled, the disabled row is a row (not a ghost
// card), and picking "Code review" tags the minted workbench rather than
// leaving it blank.

import { afterEach, describe, expect, test } from "bun:test";
import {
  CODE_REVIEW_TEMPLATE,
  DUE_DILIGENCE_TEMPLATE,
  serializeWorkbenchTemplateManifest,
} from "@corbits/workflow-catalog";
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
    // picker offers rows from and the create flow instantiates from,
    // never a hardcoded import.
    if (path.endsWith("/library/templates")) {
      return Promise.resolve(
        json({
          data: [
            {
              id: "code-review",
              content: serializeWorkbenchTemplateManifest(CODE_REVIEW_TEMPLATE),
            },
          ],
        }),
      );
    }
    if (path.endsWith("/library/templates/code-review")) {
      return Promise.resolve(
        json({
          id: "code-review",
          content: serializeWorkbenchTemplateManifest(CODE_REVIEW_TEMPLATE),
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
    if (container.querySelector('[role="radiogroup"]') !== null) break;
  }
}

describe("NewWorkbenchPickerRoute", () => {
  test("is the row list the mock specs: three rows, no card grid", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    const group = container?.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute("aria-label")).toBe("Workbench kind");

    const radios = container?.querySelectorAll('[role="radio"]');
    expect(radios?.length).toBe(2);
    expect(container?.textContent).toContain("Code review");
    expect(container?.textContent).toContain("Just start talking");
    expect(container?.textContent).toContain("More kinds soon");
  });

  // The library seeds every shipped template (`createTemplateLibrarySeeder`),
  // so a bench whose library serves due-diligence too offers it as a real
  // row, not just an entry in the static row catalog with nothing to back it.
  test("due-diligence is offered as a selectable row once the library serves it", async () => {
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
                content:
                  serializeWorkbenchTemplateManifest(CODE_REVIEW_TEMPLATE),
              },
              {
                id: "due-diligence",
                content: serializeWorkbenchTemplateManifest(
                  DUE_DILIGENCE_TEMPLATE,
                ),
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as typeof fetch;
    await renderPicker();

    const radios = Array.from(
      container?.querySelectorAll('[role="radio"]') ?? [],
    );
    expect(radios.length).toBe(3);
    const dueDiligence = radios.find((row) =>
      row.textContent?.includes("Research & due diligence"),
    );
    expect(dueDiligence).not.toBeUndefined();
    expect(dueDiligence?.textContent).toContain(
      "Scout researches the web and what your team already knows",
    );
  });

  // CL-6458: the picker offers what the bench's library can actually
  // serve. A row the library has no manifest for is shown as not set up
  // — never offered and then dead-ended on a 404 at create time.
  test("a kind this bench's library cannot serve is not offered", async () => {
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

    const radios = Array.from(
      container?.querySelectorAll('[role="radio"]') ?? [],
    );
    expect(radios.length).toBe(1);
    expect(radios[0]?.textContent).toContain("Just start talking");
    expect(container?.textContent).toContain("Code review");
    expect(container?.textContent).toContain("Not set up on this bench yet");
  });

  test("when the library can't be read, the row list says so instead of offering a dead end", async () => {
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
    const radios = Array.from(
      container?.querySelectorAll('[role="radio"]') ?? [],
    );
    expect(radios.length).toBe(1);
    expect(radios[0]?.textContent).toContain("Just start talking");
  });

  test("Code review is selected on entry, so Create workbench starts enabled", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    const rows = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    const codeReview = rows.find((row) =>
      row.textContent?.includes("Code review"),
    );
    expect(codeReview?.getAttribute("aria-checked")).toBe("true");
    expect(codeReview?.textContent).toContain("Selected");

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    expect(createButton?.disabled).toBe(false);
  });

  test("the third row is disabled, not selectable, and carries no radio role", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    const disabledRow = Array.from(
      container?.querySelectorAll('[aria-disabled="true"]') ?? [],
    ).find((row) => row.textContent?.includes("More kinds soon"));
    expect(disabledRow).not.toBeUndefined();
    expect(disabledRow?.getAttribute("role")).not.toBe("radio");
    expect(container?.querySelectorAll('[role="radio"]').length).toBe(2);
  });

  test("clicking a row switches the selection", async () => {
    stubFetch(() => undefined);
    await renderPicker();

    const rows = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [],
    );
    const justTalk = rows.find((row) =>
      row.textContent?.includes("Just start talking"),
    );
    await act(async () => {
      justTalk?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(justTalk?.getAttribute("aria-checked")).toBe("true");
    const codeReview = rows.find((row) =>
      row.textContent?.includes("Code review"),
    );
    expect(codeReview?.getAttribute("aria-checked")).toBe("false");
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

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  test("creating with Code review selected mints a workbench from the template, then navigates in", async () => {
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
          kind: "chat",
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
      if (path.endsWith("/chat/workbenches/chan_new/settings")) {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
          settings: {
            "template/id": "code-review",
            "template/pendingConnections": ["github"],
          },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      // The create flow checks whether GitHub is already connected
      // (CL-6386's "select on new-workbench" half) before deciding
      // whether to post the in-room card or go straight to repo
      // selection — nothing is connected in this fixture, so every
      // connector resolves 404/not-found.
      if (path.includes("/credentials/resolve/")) {
        return json({ error: "not_found" }, 404);
      }
      return undefined;
    });

    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
      kind: "chat",
      definitionId: "wfd_assistant",
      templatePromise:
        "Three reviewers read every pull request and post what they'd change.",
    });

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

  test("with GitHub already connected, the create flow skips the in-room card and mints grants from an inline repo pick (CL-6386)", async () => {
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
          kind: "chat",
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
      if (path.endsWith("/chat/workbenches/chan_new/settings")) {
        return json({
          id: "chan_new",
          title: "New Workbench",
          kind: "chat",
          pinned: false,
          participants: [],
          settings: {
            "template/id": "code-review",
            "template/pendingConnections": ["github"],
          },
          contextWindow: { value: 0, source: "inherit" },
        });
      }
      // GitHub already connected at the tenant level.
      if (path.includes("/credentials/resolve/GitHub")) {
        return json({
          id: "cred_github",
          tenantId: "tnt_1",
          name: "GitHub",
          status: "active",
        });
      }
      if (path.includes("/credentials/resolve/")) {
        return json({ error: "not_found" }, 404);
      }
      if (path.endsWith("/workbenches/chan_new/github/state")) {
        return json({
          kind: "connected",
          orgName: "acme",
          repos: [
            {
              id: "repo_widgets",
              name: "acme/widgets",
              openPullRequestCount: 2,
            },
            {
              id: "repo_sprockets",
              name: "acme/sprockets",
              openPullRequestCount: 0,
            },
          ],
          selectedRepoIds: [],
        });
      }
      if (
        path.endsWith("/workbenches/chan_new/github/start-reviewing") &&
        init?.method === "POST"
      ) {
        return json({ startedTriggerCount: 1 });
      }
      return undefined;
    });

    const navigated: string[] = [];
    await renderPicker((to) => navigated.push(to));

    const createButton = Array.from(
      container?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Create workbench");
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    let startReviewingButton: HTMLButtonElement | undefined;
    for (let i = 0; i < 20; i++) {
      await settle();
      startReviewingButton = Array.from(
        document.querySelectorAll("button"),
      ).find((button) => button.textContent?.startsWith("Start reviewing"));
      if (startReviewingButton !== undefined) break;
    }
    expect(startReviewingButton).not.toBeUndefined();
    expect(document.body.textContent).toContain(
      "Choose repos this workbench can work on",
    );

    const selectAllButton = Array.from(
      document.querySelectorAll("button"),
    ).find((button) => button.textContent === "Select all");
    await act(async () => {
      selectAllButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    await act(async () => {
      startReviewingButton?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
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
    expect(
      JSON.parse(String(createWorkbenchCall?.init?.body)),
    ).not.toHaveProperty("connectGithubRequiredFor");

    const startReviewingCall = calls.find((call) =>
      call.path.endsWith("/workbenches/chan_new/github/start-reviewing"),
    );
    expect(startReviewingCall).not.toBeUndefined();
  });
});
