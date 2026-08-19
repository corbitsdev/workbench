// CL-6289: the settings-UI half of the Memory section. Pins the copy for
// each `source` state (env-only now — no connected-credential state left),
// that lexical-only never reads as broken or as an alarm, that setup
// options render with the right per-kind treatment (an operator-only
// env-var row, an already-active lexical-only row), that a real degrade
// escalation IS surfaced while the deliberate `lexical_only` flag never is,
// and that any failure of this route (by construction, always a genuine
// infra fault — see `apps/hub/src/memory-mount.ts`) reads as an operator
// problem rather than a fixable-looking button.

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import { MemorySection } from "../src/memory-section";
import type {
  MemoryCallerScope,
  MemoryPlaneStatus,
} from "../src/memory-api";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 10)));

const NO_DEGRADE = {
  totalSearches: 0,
  since: "2026-01-01T00:00:00.000Z",
  windowSize: 0,
  windowedDegradeRate: {},
  escalated: {},
};

// A working plane, so a test about who is asking can never pass because the
// plane itself happened to be unavailable.
const LEXICAL_PLANE: MemoryPlaneStatus = {
  source: "lexical-only",
  embeddingsConfigured: false,
  embed: null,
  rerank: { configured: false },
  degrade: NO_DEGRADE,
  missing: [],
  setupOptions: [],
};

function renderSection(
  plane: MemoryPlaneStatus,
  caller: MemoryCallerScope = { kind: "scoped" },
) {
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/tenants/ten_1/memory/status")
      return json({ plane, caller });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  return { container, root };
}

describe("MemorySection", () => {
  test("an env source reads as working, attributed to the deploy's own setup", async () => {
    const { container, root } = renderSection({
      source: "env",
      embeddingsConfigured: true,
      embed: { model: "text-embedding-3-small", host: "api.openai.com" },
      rerank: { configured: false },
      degrade: NO_DEGRADE,
      missing: [],
      setupOptions: [],
    });
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain(
        "Set up for this deploy by an operator.",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("lexical-only reads as a real, working mode — not broken, not equivalent to meaning search", async () => {
    const { container, root } = renderSection({
      source: "lexical-only",
      embeddingsConfigured: false,
      embed: null,
      rerank: { configured: false },
      degrade: NO_DEGRADE,
      missing: ["a dense embedding endpoint — set one for this deploy"],
      setupOptions: [
        {
          kind: "set-env",
          label: "Set an embedding endpoint for this deploy",
          envVars: ["EMBED_BASE_URL", "EMBED_MODEL"],
        },
        {
          kind: "lexical-only",
          label: "Stay on full-text search (lexical-only)",
          caveat:
            "No embeddings account needed — this deploy's Postgres already has pgvector.",
        },
      ],
    });
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain(
        "The assistant can find memories that share words — not yet by meaning.",
      );
      expect(container.textContent).toContain("Working — word search");
      // Never presented as an alarm: no inline-error rendered from a chosen
      // lexical-only deploy alone (degrade is otherwise clean).
      expect(container.querySelector(".settings-inline-error")).toBeNull();

      expect(container.textContent).toContain("Turn on meaning-based search");
      expect(container.textContent).toContain(
        "Set an embedding endpoint for this deploy",
      );
      expect(container.textContent).toContain(
        "An operator sets: EMBED_BASE_URL, EMBED_MODEL",
      );
      expect(container.textContent).toContain(
        "Stay on full-text search (lexical-only)",
      );
      expect(container.textContent).toContain("Currently active");
      expect(container.textContent).toContain("No embeddings account needed");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a real degrade escalation is surfaced, but the deliberate lexical_only flag never alarms", async () => {
    const { container, root } = renderSection({
      source: "lexical-only",
      embeddingsConfigured: false,
      embed: null,
      rerank: { configured: false },
      degrade: {
        totalSearches: 400,
        since: "2026-01-01T00:00:00.000Z",
        windowSize: 200,
        windowedDegradeRate: { lexical_only: 1, rerank_unavailable: 0.4 },
        escalated: { lexical_only: true, rerank_unavailable: true },
      },
      missing: ["a dense embedding endpoint"],
      setupOptions: [
        {
          kind: "lexical-only",
          label: "Stay on full-text search (lexical-only)",
          caveat: "No embeddings account needed.",
        },
      ],
    });
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      const alarm = container.querySelector(".settings-inline-error");
      expect(alarm).not.toBeNull();
      expect(alarm?.textContent).toContain("Result ranking stopped working");
      expect(alarm?.textContent).not.toContain("lexical_only");
      // Only the one escalated, non-lexical_only flag appears in the
      // alarm line — dense_unavailable never escalated, so its label has
      // no business in the banner (it can still show up, at 0%, in the
      // Details rate table below, which this assertion does not reach).
      expect(alarm?.textContent).not.toContain(
        "Meaning-based search stopped working",
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a failed status fetch reads as an operator-side problem, not a self-service fix", async () => {
    globalThis.fetch = (async () =>
      new Response("Internal Server Error", {
        status: 500,
      })) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain(
        "Memory can't run on this deploy",
      );
      expect(container.textContent).toContain("an operator needs to check");
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Check again",
      );
      expect(button).not.toBeUndefined();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("no tenant selected shows the shared empty state, not a fetch attempt", async () => {
    globalThis.fetch = (async (url: string) => {
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    try {
      act(() => {
        root.render(<MemorySection tenantId={null} />);
      });
      await settle();

      expect(container.textContent).toContain("No workbench selected");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
  // A guest holds no memory here. Before this, the same situation reached
  // the page as a thrown 403 and rendered "Memory can't run on this deploy"
  // with a Check again button — telling a person the server is broken and
  // inviting them to retry something that will never succeed.
  test("a guest is told the memory here isn't theirs — never that the deploy is broken, and with nothing to retry", async () => {
    const { container, root } = renderSection(LEXICAL_PLANE, {
      kind: "unscoped",
      reason: "no-org-principal",
    });
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain("Memory here isn't yours");
      expect(container.textContent).not.toContain("Check again");
      expect(container.textContent).not.toContain("an operator");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test("a caller above every account is told there is no account to remember under", async () => {
    const { container, root } = renderSection(LEXICAL_PLANE, {
      kind: "unscoped",
      reason: "no-account-tenant",
    });
    try {
      act(() => {
        root.render(<MemorySection tenantId="ten_1" />);
      });
      await settle();

      expect(container.textContent).toContain("No account to remember under");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
