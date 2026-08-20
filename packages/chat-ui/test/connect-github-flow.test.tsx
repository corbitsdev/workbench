// Composition test for CL-6345: the whole connect-github round trip,
// end to end through fakes only — no real HTTP, no real DB, no real
// GitHub. Renders a template room's connect card via
// `WorkbenchTimeline` (the real registry, the real container, the real
// presentational `ConnectGithubBlockView`), drives it through connect →
// list repos → pick three → "Start reviewing", and proves:
//   1. `@corbits/workflow-catalog`'s real `startReviewingRepos` mints
//      one grant and one webhook trigger per selected repo, and records
//      the selection.
//   2. The card settles into its connected state purely by folding a
//      `chat.settings` stream event through the real
//      `applyConnectGithubSettingsEvent` — never a second
//      `getConnectState` fetch.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type { ChatSettingsEventData } from "@corbits/chat/stream-events";
import {
  startReviewingRepos,
  type ConnectGithubSetupPorts,
} from "@corbits/workflow-catalog";

import type { MessageItem } from "../src/api";
import type {
  ConnectGithubActions,
  ConnectGithubQuery,
  ConnectGithubRepo,
} from "../src/blocks/connect-github-actions";
import { applyConnectGithubSettingsEvent } from "../src/blocks/connect-github-stream";
import { WorkbenchTimeline } from "../src/timeline";

const REPOS: readonly ConnectGithubRepo[] = [
  { id: "1", name: "acme/checkout", openPullRequestCount: 4 },
  { id: "2", name: "acme/billing-api", openPullRequestCount: 0 },
  { id: "3", name: "acme/web", openPullRequestCount: 7 },
  { id: "4", name: "acme/mobile", openPullRequestCount: 1 },
];

function messageWithConnectGithubBlock(): MessageItem[] {
  return [
    {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          kind: "block",
          block: {
            type: "connect-github",
            data: { requiredForTemplate: "github", state: "disconnected" },
          },
        },
      ],
      sender: { name: "Myra", address: "myra@agents.example" },
    },
  ];
}

/** The whole flow's fakes, wired the way a real host would wire them:
 * `ConnectGithubActions.startReviewing` calls the real
 * `startReviewingRepos` against fake grant/trigger/settings ports, then
 * simulates the room's settings-PATCH route publishing `chat.settings`
 * (the real plumbing every `template/*` write already rides — see
 * `packages/chat/src/routes.ts`), folded through the real
 * `applyConnectGithubSettingsEvent`. */
function buildHarness() {
  const grantedRepos: string[] = [];
  const createdTriggerRepos: string[] = [];
  let persistedRepoIds: readonly string[] | undefined;
  let getConnectStateCallCount = 0;
  let connected = false;
  let subscriber: ((state: ConnectGithubQuery) => void) | undefined;

  const setupPorts: ConnectGithubSetupPorts = {
    async mintRepoGrant(repo) {
      grantedRepos.push(repo.name);
    },
    async createWebhookTrigger(repo) {
      createdTriggerRepos.push(repo.name);
      return { id: `trg_${repo.id}` };
    },
    async persistSelectedRepos(repoIds) {
      persistedRepoIds = repoIds;
    },
  };

  const actions: ConnectGithubActions = {
    async getConnectState() {
      getConnectStateCallCount += 1;
      return connected
        ? {
            kind: "connected",
            orgName: "octocat",
            repos: REPOS,
            selectedRepoIds: [],
          }
        : { kind: "disconnected" };
    },
    subscribeConnectState(_messageId, onUpdate) {
      subscriber = onUpdate;
      return () => {
        subscriber = undefined;
      };
    },
    requestConnect() {
      // Opening the card's own inline field — the actual connect happens
      // through `submitAccessToken` below.
    },
    async submitAccessToken(_token) {
      // A successful PAT connect (CL-6345's real scope; the GitHub
      // App/OAuth path is CL-6343) arrives back through the same
      // subscription channel the card already holds open — never a
      // second fetch.
      connected = true;
      subscriber?.({
        kind: "connected",
        orgName: "octocat",
        repos: REPOS,
        selectedRepoIds: [],
      });
      return { ok: true };
    },
    async startReviewing(repoIds) {
      const result = await startReviewingRepos(repoIds, REPOS, setupPorts);
      const settingsEvent: ChatSettingsEventData = {
        updatedBy: "prn_owner",
        settings: {
          "template/pendingConnections": [],
          "template/selectedRepos": repoIds,
        },
      };
      const folded = applyConnectGithubSettingsEvent(
        settingsEvent,
        "github",
        "octocat",
        REPOS,
      );
      if (folded !== undefined) subscriber?.(folded);
      return { startedTriggerCount: result.createdTriggerIds.length };
    },
    async skip() {},
  };

  return {
    actions,
    grantedRepos,
    createdTriggerRepos,
    persistedRepoIds: () => persistedRepoIds,
    getConnectStateCallCount: () => getConnectStateCallCount,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

function typeInto(element: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mount(actions: ConnectGithubActions) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <WorkbenchTimeline
        items={messageWithConnectGithubBlock()}
        connectGithubActions={actions}
      />,
    );
  });
  return container;
}

describe("connect-github round trip (CL-6345)", () => {
  test("a template room needing github renders the disconnected card first", async () => {
    const harness = buildHarness();
    const el = await mount(harness.actions);
    expect(el.textContent).toContain("Connect GitHub");
    expect(el.querySelector(".chat-block-connect-repo-row")).toBeNull();
  });

  test("connect -> list repos -> pick three -> start reviewing mints a grant and a webhook trigger per repo, and settles into the connected state via the stream, never a second fetch", async () => {
    const harness = buildHarness();
    const el = await mount(harness.actions);

    const connectButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      connectButton.click();
    });

    const tokenField = el.querySelector(
      "#connect-github-token",
    ) as HTMLInputElement;
    await act(async () => {
      typeInto(tokenField, "ghp_test123");
    });
    const submitTokenButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submitTokenButton.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.textContent).toContain("Connected to GitHub as octocat");
    expect(el.querySelectorAll(".chat-block-connect-repo-row")).toHaveLength(
      REPOS.length,
    );

    const checkboxes = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ];
    await act(async () => {
      checkboxes[0]?.click();
      checkboxes[1]?.click();
      checkboxes[2]?.click();
    });
    expect(el.textContent).toContain("4 repos found · 3 picked");

    const getConnectStateCallCountBeforeStart =
      harness.getConnectStateCallCount();

    const startButton = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    ) as HTMLButtonElement;
    expect(startButton.textContent).toBe("Start reviewing 3 repos");
    await act(async () => {
      startButton.click();
    });

    expect(harness.grantedRepos).toEqual([
      "acme/checkout",
      "acme/billing-api",
      "acme/web",
    ]);
    expect(harness.createdTriggerRepos).toEqual([
      "acme/checkout",
      "acme/billing-api",
      "acme/web",
    ]);
    expect(harness.persistedRepoIds()).toEqual(["1", "2", "3"]);

    // Settled purely from the folded stream event — no extra
    // `getConnectState` fetch beyond the initial mount + connect reads.
    expect(harness.getConnectStateCallCount()).toBe(
      getConnectStateCallCountBeforeStart,
    );
    expect(el.textContent).toContain("Connected to GitHub as octocat");
    expect(el.textContent).toContain("4 repos found · 3 picked");
  });
});
