// QueryView is the app-wide translation of loading/unauthenticated/error/
// ready — every page's failure copy and recovery affordance flow through
// here, so this suite is the one place asserting a failed query never
// strands a person with raw error text and nothing to do about it.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "../src/api";
import { QueryView, SignedOutNotice } from "../src/query-view";

function render(query: APIQuery<string>): string {
  return renderToStaticMarkup(
    <QueryView query={query} label="your benches">
      {(data) => <div>{data}</div>}
    </QueryView>,
  );
}

describe("QueryView error state", () => {
  test("shows plain, human copy — never the raw technical message", () => {
    const markup = render({
      kind: "error",
      message: "Can't reach the server. Check your connection.",
      retry: () => undefined,
    });
    expect(markup).toContain("Couldn&#x27;t load your benches");
    expect(markup).toContain(
      "Can&#x27;t reach the server. Check your connection.",
    );
  });

  test("offers a Retry action", () => {
    const markup = render({
      kind: "error",
      message: "Something went wrong. Try again.",
      retry: () => undefined,
    });
    expect(markup).toContain("Retry");
  });
});

describe("QueryView loading skeletons", () => {
  test("defaults to the fixed block skeleton", () => {
    const markup = render({ kind: "loading" });
    expect(markup).toContain("query-skeleton");
    expect(markup).not.toContain("query-skeleton-rows");
    expect(markup).not.toContain("query-skeleton-detail");
  });

  test('skeleton="rows" renders purpose-shaped list-row placeholders', () => {
    const markup = renderToStaticMarkup(
      <QueryView<string>
        query={{ kind: "loading" }}
        label="items"
        skeleton="rows"
      >
        {(data) => <div>{data}</div>}
      </QueryView>,
    );
    expect(markup).toContain("query-skeleton-rows");
    expect(markup).toContain("query-skeleton-row");
  });

  test('skeleton="detail" renders a header-plus-lines placeholder', () => {
    const markup = renderToStaticMarkup(
      <QueryView<string>
        query={{ kind: "loading" }}
        label="item"
        skeleton="detail"
      >
        {(data) => <div>{data}</div>}
      </QueryView>,
    );
    expect(markup).toContain("query-skeleton-detail");
    expect(markup).toContain("query-skeleton-detail-header");
  });
});

describe("SignedOutNotice", () => {
  test("offers a real Reload action, not just copy", () => {
    const markup = renderToStaticMarkup(<SignedOutNotice />);
    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Reload");
  });
});
