/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { type ReactNode } from "react";
import ArtifactBody from "./ArtifactBody";

const originalFetch = globalThis.fetch;

function textResponse(
  body: string,
  init: {
    status?: number;
    contentType?: string | null;
    contentLength?: number;
  } = {},
): Response {
  const headers = new Map<string, string>();
  const contentType =
    init.contentType === undefined
      ? "text/csv; charset=utf-8"
      : init.contentType;
  if (contentType !== null) headers.set("content-type", contentType);
  if (init.contentLength !== undefined) {
    headers.set("content-length", String(init.contentLength));
  }
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

function withQueryClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(React.createElement(QueryClientProvider, { client }, node));
}

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const TEST_BODY = "# Hello\n\nThis is test content.";
const containsHello = (content: string) => content.includes("Hello");

function renderKind(kind: string, source?: Record<string, unknown> | null) {
  return render(
    React.createElement(ArtifactBody, {
      artifact: { content: TEST_BODY, kind, source },
    }),
  );
}

describe("ArtifactBody rendering", () => {
  it("renders email body for email", () => {
    renderKind("email");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders linkedin body for linkedin-post", () => {
    renderKind("linkedin-post");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders linkedin body for twitter-post", () => {
    renderKind("twitter-post");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders linkedin body for founder-pov-post", () => {
    renderKind("founder-pov-post");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders one-pager body for one-pager", () => {
    renderKind("one-pager");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders one-pager body for blog", () => {
    renderKind("blog");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders one-pager body for case-study", () => {
    renderKind("case-study");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders one-pager body for objection-handling", () => {
    renderKind("objection-handling");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders one-pager body for customer-quotes", () => {
    renderKind("customer-quotes");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders battlecard body for battlecard", () => {
    renderKind("battlecard");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders markdown body for pain-points", () => {
    renderKind("pain-points");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders markdown body for call-transcript", () => {
    renderKind("call-transcript");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders markdown body for unknown kind instead of blank screen", () => {
    renderKind("unknown-kind");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  // Backward-compatibility: old artifact kind names still render
  it("renders email body for follow-up-email (legacy)", () => {
    renderKind("follow-up-email");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders linkedin body for pain-points-linkedin-post (legacy)", () => {
    renderKind("pain-points-linkedin-post");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders linkedin body for pain-points-twitter-post (legacy)", () => {
    renderKind("pain-points-twitter-post");
    expect(screen.getByText(containsHello)).not.toBeNull();
  });

  it("renders one-pager body for sales-one-pager (legacy)", () => {
    renderKind("sales-one-pager");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders one-pager body for case-study-draft (legacy)", () => {
    renderKind("case-study-draft");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("falls back to markdown for a research artifact without a structured brief", () => {
    renderKind("research");
    expect(screen.getByText("Hello")).not.toBeNull();
  });

  it("renders a csv-export artifact as a table plus a download link", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-9",
          content: "name,city\nAlice,Denver\n",
          kind: "csv-export",
        },
      }),
    );
    const link = screen.getByRole("link", {
      name: /download csv/i,
    }) as HTMLAnchorElement;
    // buildApiUrl resolves to an absolute same-origin URL; assert the path suffix.
    expect(link.getAttribute("href")).toMatch(
      /\/api\/v1\/artifacts\/art-9\/download$/,
    );
    // The inline text is parsed into a real table with real cells.
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["name", "city"]);
    within(table).getByText("Alice");
    within(table).getByText("Denver");
  });

  it("fetches and renders an uploaded text/csv file as a table", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(textResponse("region,total\nWest,42\n")),
    ) as unknown as typeof fetch;
    withQueryClient(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-csv",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "sales.csv", mimeType: "text/csv" },
          },
        },
      }),
    );
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["region", "total"]);
    within(table).getByText("West");
    within(table).getByText("42");
    screen.getByRole("link", { name: /download csv/i });
  });

  it("renders a table for a vendor-mime .csv (Excel reports application/vnd.ms-excel)", async () => {
    // Production truth: the download route echoes the stored upload mime, so the
    // response Content-Type is the SAME vendor mime as source.upload.mimeType —
    // they cannot diverge. A strict text/csv gate would wrongly reject this.
    const storedMime = "application/vnd.ms-excel";
    globalThis.fetch = mock(() =>
      Promise.resolve(textResponse("a,b\n1,2\n", { contentType: storedMime })),
    ) as unknown as typeof fetch;
    withQueryClient(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-csv2",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "export.csv", mimeType: storedMime },
          },
        },
      }),
    );
    const table = await screen.findByRole("table");
    within(table).getByText("1");
    within(table).getByText("2");
  });

  it("falls back to a download link when the uploaded CSV bytes fail to load", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(textResponse("nope", { status: 500 })),
    ) as unknown as typeof fetch;
    withQueryClient(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-csv3",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "broken.csv", mimeType: "text/csv" },
          },
        },
      }),
    );
    const link = await screen.findByRole("link", { name: /download broken/i });
    expect(link.getAttribute("href")).toMatch(
      /\/api\/v1\/artifacts\/art-csv3\/download$/,
    );
    expect(screen.queryByRole("table")).toBeNull();
    // Legible failure, not a silent bare link.
    screen.getByText(/preview unavailable/i);
  });

  it("degrades a routed-in but ragged CSV to raw text, not a shifted table", async () => {
    // The bytes reach the viewer (routed by mime/extension) but the arktype
    // tabular narrow rejects the ragged rows, so it falls back to raw text.
    const ragged = "a,b,c\n1,2\n";
    globalThis.fetch = mock(() =>
      Promise.resolve(textResponse(ragged, { contentType: "text/csv" })),
    ) as unknown as typeof fetch;
    withQueryClient(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-ragged",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "ragged.csv", mimeType: "text/csv" },
          },
        },
      }),
    );
    await screen.findByText((content) => content.includes("a,b,c"));
    expect(screen.queryByRole("table")).toBeNull();
    screen.getByRole("link", { name: /download csv/i });
  });

  it("refuses to preview an uploaded CSV whose declared size exceeds the cap", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        textResponse("a,b\n1,2\n", {
          contentType: "text/csv",
          contentLength: 50_000_000,
        }),
      ),
    ) as unknown as typeof fetch;
    withQueryClient(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-big",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "huge.csv", mimeType: "text/csv" },
          },
        },
      }),
    );
    await screen.findByText(/too large to preview/i);
    expect(screen.queryByRole("table")).toBeNull();
    screen.getByRole("link", { name: /download csv/i });
  });

  it("renders a non-CSV uploaded file as a plain download link, not a table", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-pdf",
          content: "",
          kind: "file",
          source: {
            upload: { filename: "report.pdf", mimeType: "application/pdf" },
          },
        },
      }),
    );
    const link = screen.getByRole("link", { name: /download report/i });
    expect(link.getAttribute("href")).toMatch(
      /\/api\/v1\/artifacts\/art-pdf\/download$/,
    );
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders web artifacts in a sandboxed iframe with a full-screen toggle", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          content:
            "<!doctype html><html><body><h1>Pitch deck</h1></body></html>",
          kind: "web",
        },
      }),
    );

    const frame = screen.getByTitle(
      "Web artifact preview",
    ) as HTMLIFrameElement;
    expect(frame.getAttribute("srcdoc")).toContain("Pitch deck");
    expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
    // Null-origin isolation plus no popup/form escape hatches (see WebBody).
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-popups");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-forms");

    fireEvent.click(screen.getByRole("button", { name: /open full screen/i }));
    screen.getByRole("dialog", { name: /web artifact full screen preview/i });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /open full screen/i }));
    screen.getByRole("dialog", { name: /web artifact full screen preview/i });
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows an empty state instead of a blank iframe for a contentless web artifact", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: { content: "   ", kind: "web" },
      }),
    );
    expect(screen.queryByTitle("Web artifact preview")).toBeNull();
    screen.getByText(/no content to preview/i);
  });

  it("renders unrecognized kinds with the document fallback", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          content: "Some opportunity notes",
          kind: "reddit-opportunity-scan",
          source: {},
        },
      }),
    );

    expect(screen.getByText("Some opportunity notes")).not.toBeNull();
  });

  it("routes ab-comparison to the compare renderer, not a raw JSON dump", () => {
    const result = {
      summary: "Variant B wins on clarity.",
      ranking: [
        {
          rank: 1,
          label: "Variant B",
          rationale: "Sharper hook and a concrete number.",
        },
      ],
      variants: [{ label: "Variant B", content: "Hello there B." }],
    };
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          content: JSON.stringify(result),
          kind: "ab-comparison",
        },
      }),
    );
    screen.getByText("Variant B wins on clarity.");
    screen.getByText("Sharper hook and a concrete number.");
    // The raw JSON braces must NOT leak through as visible text.
    if (screen.queryByText(/"ranking"/) !== null) {
      throw new Error("ab-comparison must not render as a raw JSON dump");
    }
  });

  it("caps a prose document body at the 68ch reading measure", () => {
    const { container } = renderKind("blog");
    const prose = container.querySelector("div.wb-markdown");
    if (prose === null) throw new Error("expected a prose wrapper");
    expect(prose.className).toContain("max-w-[68ch]");
    expect(prose.className).not.toContain("max-w-none");
    // Left-aligned (no centering), matching ResearchBody's measure so prose
    // shares the page's left edge with the header rather than floating centered.
    expect(prose.className).not.toContain("mx-auto");
  });

  it("renders a GFM table inside the prose surface in a horizontal-scroll container", () => {
    const { container } = render(
      React.createElement(ArtifactBody, {
        artifact: {
          content: "| A | B |\n| --- | --- |\n| 1 | 2 |",
          kind: "one-pager",
        },
      }),
    );
    // One rendering path: the table is parsed by the shared <Markdown> (GFM) and
    // lives inside the prose surface, each table wrapped for horizontal scroll
    // rather than overflowing the narrow dock width.
    const table = container.querySelector("table");
    if (table === null) throw new Error("expected a rendered <table>");
    expect(table.closest(".wb-markdown")).not.toBeNull();
    const scroller = table.closest(".overflow-x-auto");
    if (scroller === null)
      throw new Error("expected the table in a horizontal-scroll container");
  });

  it("does not render a download link for non-export kinds", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-9",
          content: TEST_BODY,
          kind: "one-pager",
        },
      }),
    );
    expect(screen.queryByRole("link", { name: /download csv/i })).toBeNull();
  });
});
