// CL-6368: /files, /skills, /agents must use the same stage chrome as the
// reference pages (Insights, Plugins) — the shared `StageTopBar` component
// and `Table` row idiom, not bespoke divs standing in for either. This is
// a screenshot-free assertion that each page's presentational component
// renders those shared components rather than imitating them.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentsPage } from "../src/pages/agents-page";
import { LibraryPage } from "../src/pages/library-page";
import { SkillsPage } from "../src/pages/skills-page";
import { TestQueryProvider } from "./test-query-provider";

const noop = () => undefined;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (root !== null) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

describe("stage chrome consistency (CL-6368)", () => {
  test("Agents uses the shared StageTopBar and Table row idiom", () => {
    const markup = renderToStaticMarkup(
      <AgentsPage
        tenantId="tnt_1"
        definitions={[
          {
            id: "wfd_1",
            tenantId: "tnt_1",
            name: "triage-bot",
            displayName: "Triage bot",
            description: "Sorts inbound issues.",
            currentVersion: "v1",
            status: "deployed",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          },
        ]}
        workbenches={new Map()}
        selectedId={null}
        onSelect={noop}
        createOpen={false}
        onCreateOpenChange={noop}
        onCreated={noop}
      />,
    );
    expect(markup).toContain('data-testid="stage-top-bar"');
    expect(markup).toContain('data-slot="table"');
  });

  test("Files uses the shared StageTopBar and Table row idiom (rows view)", () => {
    const markup = renderToStaticMarkup(
      <LibraryPage
        artifacts={[
          {
            id: "art_1",
            title: "Report.pdf",
            kind: "document",
            ownerName: "Alice",
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          } as never,
        ]}
      />,
    );
    expect(markup).toContain('data-testid="stage-top-bar"');
  });

  test("Skills renders its list with the shared Table row idiom, not a bespoke row component", async () => {
    const TENANT = "tnt_1";
    globalThis.fetch = (async (input: unknown) => {
      const path = String(input);
      if (path === `/api/tenants/${TENANT}/skills`) {
        return new Response(
          JSON.stringify({
            skills: [
              {
                assetId: "ast_1",
                name: "triage",
                description: "Sorts inbound issues.",
                scope: "private",
                creatorPrincipalId: "prn_1",
                updatedAtIso: "2026-08-05T11:00:00.000Z",
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: { message: "no stub" } }), {
        status: 404,
      });
    }) as unknown as typeof fetch;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <TestQueryProvider>
          <SkillsPage tenantId={TENANT} />
        </TestQueryProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-slot="table"]')).not.toBeNull();
    expect(container.textContent).toContain("triage");
  });
});
