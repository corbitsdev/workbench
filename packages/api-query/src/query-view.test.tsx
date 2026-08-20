// QueryView is the shared translation of loading/unauthenticated/error/
// ready — every host page's failure copy and recovery affordance flow
// through here, so this suite is the one place asserting a failed query
// never strands a person with raw error text and nothing to do about it.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { APIQuery } from "./envelope";
import { QueryView, SignedOutNotice } from "./query-view";

function render(query: APIQuery<string>): string {
  return renderToStaticMarkup(
    <QueryView query={query} label="your benches">
      {(data) => <div>{data}</div>}
    </QueryView>,
  );
}

describe("QueryView error state", () => {
  test("never renders the raw technical message, even when it carries a path", () => {
    const markup = render({
      kind: "error",
      message: "The server answered 500 for /api/tenants/abc-123/benches.",
      retry: () => undefined,
    });
    expect(markup).toContain("Couldn&#x27;t load your benches");
    expect(markup).not.toMatch(/\/api\//);
    expect(markup).not.toContain("abc-123");
    expect(markup).toContain(
      "Something went wrong loading your benches. Try again.",
    );
  });

  test("404 reads as gone, not as a generic failure", () => {
    const markup = render({
      kind: "error",
      message: "The server answered 404 for /api/tenants/abc-123/benches.",
      retry: () => undefined,
      status: 404,
    });
    expect(markup).toContain("This isn&#x27;t here anymore.");
  });

  test("401/403 reads as an access problem", () => {
    const markup = render({
      kind: "error",
      message: "The server answered 403 for /api/tenants/abc-123/benches.",
      retry: () => undefined,
      status: 403,
    });
    expect(markup).toContain("You don&#x27;t have access to this.");
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

  test("loadingContent overrides the skeleton entirely for a page-level wait", () => {
    const markup = renderToStaticMarkup(
      <QueryView<string>
        query={{ kind: "loading" }}
        label="item"
        loadingContent={<div className="my-warm-loader">Hang tight…</div>}
      >
        {(data) => <div>{data}</div>}
      </QueryView>,
    );
    expect(markup).toContain("my-warm-loader");
    expect(markup).toContain("Hang tight…");
    expect(markup).not.toContain("query-skeleton");
  });
});

describe("SignedOutNotice", () => {
  test("offers a real Reload action, not just copy", () => {
    const markup = renderToStaticMarkup(<SignedOutNotice />);
    expect(markup).toContain("Sign in required");
    expect(markup).toContain("Reload");
  });
});
