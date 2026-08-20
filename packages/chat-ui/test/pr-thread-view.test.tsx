// DOM tests for the Reviews-room PR thread (CL-6342 screen 3, plus screen
// 4's turn states). This view is not wired into the timeline yet, so these
// tests mount `PrThreadView` and `PrQueuedStrip` directly, the same
// standalone-mount shape `connect-github-block.test.tsx` uses. Covers: the
// settled thread footer, the live thread footer with next-reviewer
// avatars, the three status chip tones, the suggested-fix block and its
// actions, the "view the work" trace callback, the queued strip, the
// failed-turn strip scoped to one reply with working Retry/what-happened
// callbacks, and accessibility (real buttons, labelled controls).

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import type {
  PrThreadFailedTurn,
  PrThreadReply,
  PrThreadViewProps,
} from "../src/pr-thread-view";
import { PrQueuedStrip, PrThreadView } from "../src/pr-thread-view";

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

async function mount(props: PrThreadViewProps) {
  return mountElement(<PrThreadView {...props} />);
}

const SETTLED_REPLIES: readonly PrThreadReply[] = [
  {
    id: "r1",
    sender: "Greybeard",
    role: "reviewer",
    time: "9:46 AM",
    text: "The retry has no ceiling on the charge amount.",
    trace: { stepCount: 6, seconds: 41, onViewWork: () => undefined },
  },
  {
    id: "r2",
    sender: "CTO",
    role: "reviewer",
    time: "9:47 AM",
    text: "Shape is right and it stays inside the payment module.",
    trace: { stepCount: 4, seconds: 22, onViewWork: () => undefined },
  },
];

describe("PrThreadView — settled thread", () => {
  test("renders the header, reply rows, and the settled footer verbatim", async () => {
    const el = await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: SETTLED_REPLIES,
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => undefined,
      },
    });

    expect(el.textContent).toContain("#482");
    expect(el.textContent).toContain("Retry failed card charges once");
    expect(el.textContent).toContain("acme/checkout · Priya Vale");
    expect(el.textContent).toContain("Reviewed");
    expect(el.textContent).toContain("Greybeard");
    expect(el.textContent).toContain("CTO");
    expect(el.textContent).toContain(
      "All three posted to acme/checkout · 9:48 AM",
    );

    const link = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "View on GitHub",
    ) as HTMLButtonElement | undefined;
    expect(link).not.toBeUndefined();
  });

  test("the settled footer's View on GitHub button fires its callback", async () => {
    let clicked = false;
    await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: SETTLED_REPLIES,
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => {
          clicked = true;
        },
      },
    });

    const link = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "View on GitHub",
    ) as HTMLButtonElement;
    await act(async () => {
      link.click();
    });
    expect(clicked).toBe(true);
  });

  test("each reply's trace button reports its own callback with no cross-talk", async () => {
    const viewed: string[] = [];
    await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "9:46 AM",
          text: "Guard on the idempotency key.",
          trace: {
            stepCount: 6,
            seconds: 41,
            onViewWork: () => viewed.push("r1"),
          },
        },
        {
          id: "r2",
          sender: "CTO",
          role: "reviewer",
          time: "9:47 AM",
          text: "Shape is right.",
          trace: {
            stepCount: 4,
            seconds: 22,
            onViewWork: () => viewed.push("r2"),
          },
        },
      ],
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => undefined,
      },
    });

    const traceButtons = [...document.querySelectorAll("button")].filter(
      (button) => button.textContent?.startsWith("view the work"),
    ) as HTMLButtonElement[];
    expect(traceButtons).toHaveLength(2);
    expect(traceButtons[0]?.textContent).toBe("view the work · 6 steps, 41s");
    expect(traceButtons[1]?.textContent).toBe("view the work · 4 steps, 22s");

    await act(async () => {
      traceButtons[1]?.click();
    });
    expect(viewed).toEqual(["r2"]);
  });

  test("a single-step trace pluralizes to '1 step'", async () => {
    const el = await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "9:46 AM",
          text: "Quick pass.",
          trace: { stepCount: 1, seconds: 4, onViewWork: () => undefined },
        },
      ],
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => undefined,
      },
    });

    expect(el.textContent).toContain("view the work · 1 step, 4s");
  });
});

describe("PrThreadView — the suggested-fix block", () => {
  test("shows the file, the del/add/ctx lines, and both actions fire their own callbacks", async () => {
    let copied = false;
    let opened = false;
    const el = await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "9:46 AM",
          text: "Guard on the idempotency key you already send.",
          suggestedFix: {
            file: "src/charge.ts",
            lines: [
              {
                kind: "context",
                text: "const key = idempotencyKeyFor(order);",
              },
              {
                kind: "removed",
                text: "return gateway.charge({ amount, card });",
              },
              {
                kind: "added",
                text: "return gateway.charge({ amount, card, idempotencyKey: key });",
              },
            ],
            onCopy: () => {
              copied = true;
            },
            onOpenOnGithub: () => {
              opened = true;
            },
          },
        },
      ],
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => undefined,
      },
    });

    expect(el.textContent).toContain("Suggested fix");
    expect(el.textContent).toContain("src/charge.ts");
    expect(el.textContent).toContain("const key = idempotencyKeyFor(order);");
    expect(el.textContent).toContain(
      "return gateway.charge({ amount, card });",
    );

    const removedLine = el.querySelector('[data-kind="removed"]');
    expect(removedLine?.textContent).toContain(
      "return gateway.charge({ amount, card });",
    );
    const addedLine = el.querySelector('[data-kind="added"]');
    expect(addedLine?.textContent).toContain("idempotencyKey: key");

    // The fix's code lines sit in a horizontally-scrollable container.
    const codeContainer = el.querySelector(".chat-pr-fix-code");
    expect(codeContainer).not.toBeNull();

    const copyButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Copy",
    ) as HTMLButtonElement;
    const openButton = [...el.querySelectorAll("button")].find(
      (button) => button.textContent === "Open on GitHub",
    ) as HTMLButtonElement;

    await act(async () => {
      copyButton.click();
    });
    expect(copied).toBe(true);

    await act(async () => {
      openButton.click();
    });
    expect(opened).toBe(true);
  });
});

describe("PrThreadView — live thread", () => {
  test("shows the reading-now status chip and the next-reviewer footer with avatars", async () => {
    const el = await mount({
      prNumber: 118,
      title: "Split invoice totals by tax region",
      repo: "acme/billing-api",
      author: "Tom Okafor",
      status: { kind: "reading" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "9:53 AM",
          text: "The rounding moved from the line item to the invoice total.",
        },
      ],
      footer: {
        kind: "live",
        nextReviewers: [
          { initials: "CT", label: "CTO" },
          { initials: "CR", label: "Critique" },
        ],
        currentReviewer: "Greybeard",
      },
    });

    expect(el.textContent).toContain("Reading now");
    expect(el.textContent).toContain(
      "CTO and Critique are next, once Greybeard finishes.",
    );

    const waitAvatars = el.querySelectorAll(
      ".chat-pr-wait-avatars [aria-label]",
    );
    expect(waitAvatars.length).toBeGreaterThanOrEqual(2);
  });

  test("a single next reviewer uses 'is next', not 'are next'", async () => {
    const el = await mount({
      prNumber: 118,
      title: "Split invoice totals by tax region",
      repo: "acme/billing-api",
      author: "Tom Okafor",
      status: { kind: "reading" },
      replies: [],
      footer: {
        kind: "live",
        nextReviewers: [{ initials: "CT", label: "CTO" }],
        currentReviewer: "Greybeard",
      },
    });

    expect(el.textContent).toContain("CTO is next, once Greybeard finishes.");
  });
});

describe("PrThreadView — status chip tones", () => {
  test("reviewed, reading, and waiting-on-you each render their mock label", async () => {
    const base = {
      prNumber: 1,
      title: "x",
      repo: "acme/x",
      author: "a",
      replies: [] as PrThreadReply[],
      footer: {
        kind: "settled" as const,
        repo: "acme/x",
        postedAt: "1:00 PM",
        onViewOnGithub: () => undefined,
      },
    };

    const reviewed = await mountElement(
      <PrThreadView {...base} status={{ kind: "reviewed" }} />,
    );
    expect(reviewed.textContent).toContain("Reviewed");
    await act(async () => root?.unmount());
    container?.remove();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<PrThreadView {...base} status={{ kind: "reading" }} />);
    });
    expect(container.textContent).toContain("Reading now");

    await act(async () => root?.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <PrThreadView {...base} status={{ kind: "waiting-on-you" }} />,
      );
    });
    expect(container.textContent).toContain("Waiting on you");
  });
});

describe("PrThreadView — failed turn (screen 4)", () => {
  const FAILED_TURN: PrThreadFailedTurn = {
    afterReplyId: "r1",
    sender: "Greybeard",
    repo: "acme/checkout",
    onRetry: () => undefined,
    onWhatHappened: () => undefined,
  };

  test("scopes the failed strip to the reply it follows, and later replies still render", async () => {
    const el = await mount({
      prNumber: 484,
      title: "Cache the tax-region lookup",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reading" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "10:13 AM",
          text: "Pulled the diff and started on the cache invalidation path—",
        },
        {
          id: "r2",
          sender: "CTO",
          role: "reviewer",
          time: "10:14 AM",
          text: "Unaffected by Greybeard's drop — my pass is done.",
        },
      ],
      failedTurn: FAILED_TURN,
      footer: {
        kind: "live",
        nextReviewers: [{ initials: "CT", label: "CTO" }],
        currentReviewer: "Greybeard",
      },
    });

    expect(el.textContent).toContain("Greybeard's review didn't finish");
    expect(el.textContent).toContain(
      "We retried once. Nothing was posted to acme/checkout.",
    );
    // The room stays visibly alive around the failed turn.
    expect(el.textContent).toContain("CTO");
    expect(el.textContent).toContain("Unaffected by Greybeard's drop");

    const rows = el.querySelectorAll(".chat-pr-reply");
    const failedStrip = el.querySelector(".chat-pr-failed");
    expect(rows).toHaveLength(2);
    expect(failedStrip).not.toBeNull();
  });

  test("Retry and what-happened fire their own distinct callbacks", async () => {
    let retried = false;
    let explained = false;
    await mount({
      prNumber: 484,
      title: "Cache the tax-region lookup",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reading" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "10:13 AM",
          text: "Pulled the diff—",
        },
      ],
      failedTurn: {
        afterReplyId: "r1",
        sender: "Greybeard",
        repo: "acme/checkout",
        onRetry: () => {
          retried = true;
        },
        onWhatHappened: () => {
          explained = true;
        },
      },
      footer: {
        kind: "live",
        nextReviewers: [{ initials: "CT", label: "CTO" }],
        currentReviewer: "Greybeard",
      },
    });

    const retryButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    ) as HTMLButtonElement;
    const whatHappenedButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "what happened",
    ) as HTMLButtonElement;

    await act(async () => {
      retryButton.click();
    });
    expect(retried).toBe(true);
    expect(explained).toBe(false);

    await act(async () => {
      whatHappenedButton.click();
    });
    expect(explained).toBe(true);
  });
});

describe("PrQueuedStrip", () => {
  test("renders the queued line verbatim with the static queue-bars glyph", async () => {
    const el = await mountElement(
      <PrQueuedStrip prNumber={77} repo="acme/web" />,
    );
    expect(el.textContent).toContain(
      "#77 in acme/web is queued — waiting for the current review to finish.",
    );
    const bars = el.querySelector(".chat-pr-queue-bars");
    expect(bars?.getAttribute("aria-hidden")).toBe("true");
    expect(bars?.querySelectorAll("span")).toHaveLength(3);
  });
});

describe("PrThreadView — accessibility", () => {
  test("trace, fix actions, footer link, and failed-turn actions are all real buttons", async () => {
    const el = await mount({
      prNumber: 482,
      title: "Retry failed card charges once",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reviewed" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "9:46 AM",
          text: "Guard on the idempotency key.",
          trace: { stepCount: 6, seconds: 41, onViewWork: () => undefined },
          suggestedFix: {
            file: "src/charge.ts",
            lines: [{ kind: "context", text: "const key = 1;" }],
            onCopy: () => undefined,
            onOpenOnGithub: () => undefined,
          },
        },
      ],
      failedTurn: {
        afterReplyId: "r1",
        sender: "Greybeard",
        repo: "acme/checkout",
        onRetry: () => undefined,
        onWhatHappened: () => undefined,
      },
      footer: {
        kind: "settled",
        repo: "acme/checkout",
        postedAt: "9:48 AM",
        onViewOnGithub: () => undefined,
      },
    });

    const buttons = el.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(6);
    for (const button of buttons) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("type")).toBe("button");
    }
  });

  test("the failed-turn strip announces itself via role=status", async () => {
    const el = await mount({
      prNumber: 484,
      title: "Cache the tax-region lookup",
      repo: "acme/checkout",
      author: "Priya Vale",
      status: { kind: "reading" },
      replies: [
        {
          id: "r1",
          sender: "Greybeard",
          role: "reviewer",
          time: "10:13 AM",
          text: "Pulled the diff—",
        },
      ],
      failedTurn: {
        afterReplyId: "r1",
        sender: "Greybeard",
        repo: "acme/checkout",
        onRetry: () => undefined,
        onWhatHappened: () => undefined,
      },
      footer: {
        kind: "live",
        nextReviewers: [{ initials: "CT", label: "CTO" }],
        currentReviewer: "Greybeard",
      },
    });

    const status = el.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.className).toContain("chat-pr-failed");
  });
});
