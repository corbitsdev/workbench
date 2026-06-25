/// <reference types="bun" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import ArtifactBody from "./ArtifactBody";

afterEach(() => {
  cleanup();
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

  it("renders a download link for a csv-export artifact", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-9",
          sessionId: "wf-1",
          content: "a,b\n1,2\n",
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

  it("does not render a download link for non-export kinds", () => {
    render(
      React.createElement(ArtifactBody, {
        artifact: {
          id: "art-9",
          sessionId: "wf-1",
          content: TEST_BODY,
          kind: "one-pager",
        },
      }),
    );
    expect(screen.queryByRole("link", { name: /download csv/i })).toBeNull();
  });
});
