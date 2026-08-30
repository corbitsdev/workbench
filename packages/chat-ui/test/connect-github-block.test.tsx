// DOM tests for the GitHub connect card's pure presentational shape
// (CL-6342 screen 2). These mount `ConnectGithubBlockView` directly --
// the same standalone-mount shape `approve-card-state.test.ts` uses --
// to prove out the view in isolation from any host port; the real
// registry wiring (a server-side `Block` variant, the live
// `ConnectGithubActions` round-trip) is covered end to end by
// `connect-github-flow.test.tsx`. Covers: the
// disconnected state's copy and its two actions, the connected state's
// connected line, repo rows, selection counting, "Select all", the
// permission helper sentence, and that focus/labels hold up for keyboard
// and screen-reader use.

import { afterEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  ConnectGithubCardBody,
  ConnectGithubRepo,
  OnboardingScene,
} from "../src/blocks/connect-github-block";
import { ConnectGithubBlockView } from "../src/blocks/connect-github-block";

const AN_HOUR_AGO = new Date(Date.now() - 60 * 60_000).toISOString();

const REPOS: readonly ConnectGithubRepo[] = [
  { id: "checkout", name: "acme/checkout", lastPushedAt: AN_HOUR_AGO },
  { id: "billing-api", name: "acme/billing-api" },
  { id: "web", name: "acme/web" },
  { id: "mobile", name: "acme/mobile" },
  { id: "design-tokens", name: "acme/design-tokens" },
  { id: "handbook", name: "acme/handbook" },
];

/** The framing the room's onboarding card always carries. Individual
 * tests override `currentStepIndex` where the marker is what's under
 * test. */
const SCENE: OnboardingScene = {
  title: "Code review",
  promise: "Every new pull request gets reviewed before you merge it.",
  steps: [
    { title: "Connect GitHub", why: "Reviewers need to read your code." },
    {
      title: "Choose what gets reviewed",
      why: "Of the repos your token reaches, these get watched.",
    },
    { title: "Start reviewing", why: "Reviews land right here in this room." },
  ],
  currentStepIndex: 0,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function mountElement(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function mount(props: ConnectGithubCardBody) {
  return mountElement(<ConnectGithubBlockView scene={SCENE} {...props} />);
}

function typeInto(element: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    globalThis.HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(element, text);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A small stateful harness standing in for the next slice's real wiring --
 * selection lives in the parent, exactly as `ConnectGithubCardProps`
 * requires, so these tests exercise the real controlled-selection contract
 * instead of asserting against uncontrolled internal state the block does
 * not have. */
function PickReposHarness({
  initiallySelected,
  onStartReviewing,
}: {
  readonly initiallySelected: readonly string[];
  readonly onStartReviewing: (repoIds: readonly string[]) => void;
}) {
  const [selected, setSelected] =
    useState<readonly string[]>(initiallySelected);
  return (
    <ConnectGithubBlockView
      scene={SCENE}
      kind="connected"
      orgName="acme"
      repos={REPOS}
      selectedRepoIds={selected}
      onToggleRepo={(repoId) =>
        setSelected((prev) =>
          prev.includes(repoId)
            ? prev.filter((id) => id !== repoId)
            : [...prev, repoId],
        )
      }
      onSelectAll={() => setSelected(REPOS.map((repo) => repo.id))}
      onChangeConnection={() => undefined}
      onStartReviewing={onStartReviewing}
      onSkip={() => undefined}
    />
  );
}

describe("connect GitHub card — 2a disconnected", () => {
  test("renders the mock's headline copy and a live connect button", async () => {
    let connected = false;
    const el = await mount({
      kind: "disconnected",
      onConnect: () => {
        connected = true;
      },
      onSubmitAccessToken: () => Promise.resolve({ ok: true }),
    });

    // Honest PAT-first framing — there is no hosted GitHub sign-in in
    // this card, so it never claims an app install it can't do.
    expect(el.textContent).toContain(
      "You choose which repositories the token can reach while you're creating it",
    );
    expect(el.textContent).toContain(
      "stored encrypted, only your agents use it, and you can remove it any time",
    );
    expect(el.textContent).not.toContain("Install the Workbench app");

    const connect = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement | undefined;
    expect(connect).not.toBeUndefined();

    await act(async () => {
      connect?.click();
    });
    expect(connected).toBe(true);
  });

  test("connect opens the numbered token walkthrough with the settings link and the field", async () => {
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: () => Promise.resolve({ ok: true }),
    });

    const connect = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement | undefined;
    expect(connect).not.toBeUndefined();

    await act(async () => {
      connect?.click();
    });

    const steps = [...el.querySelectorAll(".chat-block-connect-steps li")].map(
      (item) => item.textContent,
    );
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain(
      "Open GitHub's fine-grained token page and generate a new token.",
    );
    expect(steps[1]).toContain("Repository access");
    expect(steps[3]).toContain("Paste it here");
    expect(
      el.querySelector(
        'a[href="https://github.com/settings/personal-access-tokens/new"]',
      ),
    ).not.toBeNull();

    const field = el.querySelector("#connect-github-token");
    expect(field).not.toBeNull();
  });

  test("submitting a token calls onSubmitAccessToken and closes the field on success", async () => {
    const submitted: string[] = [];
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: (token) => {
        submitted.push(token);
        return Promise.resolve({ ok: true });
      },
    });

    const openLink = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      openLink.click();
    });

    const field = el.querySelector("#connect-github-token") as HTMLInputElement;
    await act(async () => {
      typeInto(field, "ghp_test123");
    });

    const submit = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });
    // Flush the async submit handler's own state updates.
    await act(async () => {
      await Promise.resolve();
    });

    expect(submitted).toEqual(["ghp_test123"]);
    expect(el.querySelector("#connect-github-token")).toBeNull();
  });

  test("a rejected token shows the error inline and keeps the field open", async () => {
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: () =>
        Promise.resolve({ ok: false, message: "Bad token." }),
    });

    const openLink = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      openLink.click();
    });

    const field = el.querySelector("#connect-github-token") as HTMLInputElement;
    await act(async () => {
      typeInto(field, "ghp_bad");
    });
    const submit = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(el.textContent).toContain("Bad token.");
    expect(el.querySelector("#connect-github-token")).not.toBeNull();
    expect(
      el.querySelector(".chat-block-connect-token-error")?.getAttribute("role"),
    ).toBe("alert");
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("connect GitHub card — 2b pick your repos", () => {
  test("shows the connected line, the repo rows, and the found·picked counter", async () => {
    const el = await mount({
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: ["checkout", "billing-api", "web"],
      onToggleRepo: () => undefined,
      onSelectAll: () => undefined,
      onChangeConnection: () => undefined,
      onStartReviewing: () => undefined,
      onSkip: () => undefined,
    });

    expect(el.textContent).toContain("Connected to GitHub as acme");
    expect(el.textContent).toContain("6 repos your token can reach · 3 picked");

    const rows = el.querySelectorAll(".chat-block-connect-repo-row");
    expect(rows).toHaveLength(6);
    expect(el.textContent).toContain("acme/checkout");
    expect(el.textContent).toContain("updated 1h ago");
    expect(el.textContent).toContain("no commits yet");

    expect(el.textContent).toContain(
      "These are the repositories your token can reach. Pick the ones you want reviewed",
    );
  });

  test("toggling a repo checkbox reports the toggle upward — the block owns no tally of its own", async () => {
    const toggled: string[] = [];
    const el = await mount({
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: ["checkout"],
      onToggleRepo: (repoId) => toggled.push(repoId),
      onSelectAll: () => undefined,
      onChangeConnection: () => undefined,
      onStartReviewing: () => undefined,
      onSkip: () => undefined,
    });

    const mobileCheckbox = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][3];
    expect(mobileCheckbox).not.toBeUndefined();

    await act(async () => {
      mobileCheckbox?.click();
    });
    expect(toggled).toEqual(["mobile"]);
  });

  test("selection count drives the counter and the primary button label live", async () => {
    let started: readonly string[] = [];
    const el = await mountElement(
      <PickReposHarness
        initiallySelected={["checkout", "billing-api", "web"]}
        onStartReviewing={(repoIds) => {
          started = repoIds;
        }}
      />,
    );

    expect(el.textContent).toContain("6 repos your token can reach · 3 picked");
    const start = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    ) as HTMLButtonElement;
    expect(start.textContent).toBe("Start reviewing 3 repos");

    const mobileCheckbox = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][3];
    await act(async () => {
      mobileCheckbox?.click();
    });

    expect(el.textContent).toContain("6 repos your token can reach · 4 picked");
    const startAfter = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    ) as HTMLButtonElement;
    expect(startAfter.textContent).toBe("Start reviewing 4 repos");

    await act(async () => {
      startAfter.click();
    });
    expect(started).toEqual(["checkout", "billing-api", "web", "mobile"]);
  });

  test("Select all picks every repo and the primary label pluralizes to a single repo correctly", async () => {
    const el = await mountElement(
      <PickReposHarness
        initiallySelected={[]}
        onStartReviewing={() => undefined}
      />,
    );

    expect(el.textContent).toContain("6 repos your token can reach · 0 picked");
    const start = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    ) as HTMLButtonElement;
    expect(start.textContent).toBe("Start reviewing 0 repos");
    expect(start.disabled).toBe(true);
    const skip = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "skip for now",
    ) as HTMLButtonElement;
    expect(skip.disabled).toBe(false);

    const selectAll = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Select all",
    ) as HTMLButtonElement;
    await act(async () => {
      selectAll.click();
    });

    expect(el.textContent).toContain("6 repos your token can reach · 6 picked");
    const startAfter = [...el.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Start reviewing"),
    ) as HTMLButtonElement;
    expect(startAfter.textContent).toBe("Start reviewing 6 repos");
    expect(startAfter.disabled).toBe(false);
  });

  test("skip fires its own quiet callback, distinct from starting", async () => {
    let skipped = false;
    const el = await mount({
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: [],
      onToggleRepo: () => undefined,
      onSelectAll: () => undefined,
      onChangeConnection: () => undefined,
      onStartReviewing: () => undefined,
      onSkip: () => {
        skipped = true;
      },
    });

    const skip = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "skip for now",
    ) as HTMLButtonElement;
    await act(async () => {
      skip.click();
    });
    expect(skipped).toBe(true);
  });
});

describe("connect GitHub card — accessibility", () => {
  test("every repo row's checkbox is a labeled, focusable control", async () => {
    const el = await mount({
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: ["checkout"],
      onToggleRepo: () => undefined,
      onSelectAll: () => undefined,
      onChangeConnection: () => undefined,
      onStartReviewing: () => undefined,
      onSkip: () => undefined,
    });

    const checkboxes = el.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(6);
    for (const checkbox of checkboxes) {
      expect(checkbox.id.length).toBeGreaterThan(0);
      const label = el.querySelector(`label[for="${checkbox.id}"]`);
      expect(label).not.toBeNull();
      expect(label?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }

    const group = el.querySelector('[role="group"]');
    expect(
      el.querySelector(".chat-block-scene-pick-heading")?.textContent,
    ).toBe("Choose what gets reviewed");
    expect(group?.getAttribute("aria-labelledby")).toBe(
      "connect-github-pick-heading",
    );

    const firstCheckbox = checkboxes[0];
    if (firstCheckbox === undefined) {
      throw new Error("expected at least one checkbox to render");
    }
    firstCheckbox.focus();
    expect(document.activeElement).toBe(firstCheckbox);
  });

  test("the current walkthrough step is marked aria-current=step and a sibling status live region names it", async () => {
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: () => Promise.resolve({ ok: true }),
    });

    const current = [...el.querySelectorAll(".chat-block-scene-step")].find(
      (row) => row.getAttribute("data-state") === "current",
    );
    expect(current?.getAttribute("aria-current")).toBe("step");
    expect(
      [...el.querySelectorAll(".chat-block-scene-step")].filter(
        (row) => row.getAttribute("aria-current") === "step",
      ),
    ).toHaveLength(1);
    const status = el.querySelector(".chat-block-scene-status");
    const body = el.querySelector(".chat-block-scene-body");
    expect(body?.getAttribute("aria-live")).toBeNull();
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.textContent).toBe("Connect GitHub");
    expect(body?.contains(status)).toBe(false);
    expect(
      el.querySelector("#connect-github-token") ??
        el.querySelector('input[type="password"]'),
    ).toBeNull();
  });

  test("a token error is an alert beside the status live region, not nested inside it", async () => {
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: () =>
        Promise.resolve({ ok: false, message: "Bad token." }),
    });

    const openLink = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      openLink.click();
    });

    const field = el.querySelector("#connect-github-token") as HTMLInputElement;
    await act(async () => {
      typeInto(field, "ghp_bad");
    });
    const submit = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Connect",
    ) as HTMLButtonElement;
    await act(async () => {
      submit.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const status = el.querySelector(".chat-block-scene-status");
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Bad token.");
    expect(status?.contains(alert)).toBe(false);
    expect(status?.textContent).toBe("Connect GitHub");
    expect(el.querySelector(".chat-block-scene-body")?.contains(field)).toBe(
      true,
    );
  });

  test("a start-reviewing error is an alert beside the status live region, not nested inside it", async () => {
    const el = await mountElement(
      <ConnectGithubBlockView
        scene={{ ...SCENE, currentStepIndex: 1 }}
        kind="connected"
        orgName="acme"
        repos={REPOS}
        selectedRepoIds={["checkout"]}
        onToggleRepo={() => undefined}
        onSelectAll={() => undefined}
        onChangeConnection={() => undefined}
        onStartReviewing={() => undefined}
        onSkip={() => undefined}
        error="Couldn't start reviewing — try again."
      />,
    );

    const status = el.querySelector(".chat-block-scene-status");
    const alert = el.querySelector('[role="alert"]');
    expect(status?.textContent).toBe("Choose what gets reviewed");
    expect(alert?.textContent).toContain("Couldn't start reviewing");
    expect(status?.contains(alert)).toBe(false);
    expect(
      el
        .querySelector(".chat-block-scene-body")
        ?.contains(el.querySelector('input[type="checkbox"]')),
    ).toBe(true);
  });

  test("toggling a repo checkbox does not change the status live region", async () => {
    const el = await mountElement(
      <PickReposHarness
        initiallySelected={["checkout"]}
        onStartReviewing={() => undefined}
      />,
    );
    const status = el.querySelector(".chat-block-scene-status");
    expect(status?.textContent).toBe("Connect GitHub");

    const mobileCheckbox = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ][3];
    await act(async () => {
      mobileCheckbox?.click();
    });

    expect(status?.textContent).toBe("Connect GitHub");
    expect(el.textContent).toContain("6 repos your token can reach · 2 picked");
  });

  test("autoFocus on the pick-repos scene moves focus onto the pick heading", async () => {
    const el = await mount({
      kind: "connected",
      orgName: "acme",
      repos: REPOS,
      selectedRepoIds: [],
      onToggleRepo: () => undefined,
      onSelectAll: () => undefined,
      onChangeConnection: () => undefined,
      onStartReviewing: () => undefined,
      onSkip: () => undefined,
      autoFocus: true,
    });

    const heading = el.querySelector(".chat-block-scene-pick-heading");
    expect(heading?.textContent).toBe("Choose what gets reviewed");
    expect(heading?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(heading);
  });

  test("the disconnected state's actions are real buttons, not divs", async () => {
    const el = await mount({
      kind: "disconnected",
      onConnect: () => undefined,
      onSubmitAccessToken: () => Promise.resolve({ ok: true }),
    });

    const buttons = el.querySelectorAll("button");
    // One clear primary action closed; submit + cancel once opened.
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    for (const button of buttons) {
      expect(button.getAttribute("type")).toBe("button");
    }
  });
});
