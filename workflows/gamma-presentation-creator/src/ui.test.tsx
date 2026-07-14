import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "@intx/workflow";
import { Panel } from "./ui";

// Guard: ui.tsx is lazily imported into the browser via the package's `/ui`
// export. It must NOT value-import ./index (the server-only workflow
// definition), which would pull @intx/agent into the browser chunk, throw on
// load, and drop the run view to the generic RunConsole fallback (CL-2621).
describe("ui.tsx browser-safety", () => {
  it("does not value-import the server-only ./index module", () => {
    const src = readFileSync(join(import.meta.dir, "ui.tsx"), "utf8");
    expect(src).not.toMatch(/import\s+\{[^}]*\}\s+from\s+["']\.\/index["']/);
    // The step flow/labels come from the browser-safe display-steps module
    // instead (single-shot: CL-3614).
    expect(src).toMatch(/from\s+["']\.\/display-steps["']/);
  });
});

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// Templates now load from the hub (GET /gamma-templates), not a workflow step.
// Default mock returns one template so the intake selector has options.
function mockTemplatesFetch(
  templates: unknown = [{ gammaId: "tmpl_pro", name: "Investor Deck" }],
) {
  globalThis.fetch = mock((url: string) => {
    if (String(url).includes("/gamma-templates")) {
      return Promise.resolve(jsonResponse(templates));
    }
    return Promise.resolve(jsonResponse({}, 404));
  }) as unknown as typeof fetch;
}

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(createElement(QueryClientProvider, { client }, ui));
}

beforeEach(() => {
  mockTemplatesFetch();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

type StepPhase =
  | "in-flight"
  | "awaiting-signal"
  | "awaiting-timer"
  | "completed"
  | "failed"
  | "cancelled";

function makeState(
  phases: Record<string, StepPhase>,
  runPhase: RunState["phase"] = "running",
): RunState {
  const steps = new Map<
    string,
    { stepId: string; phase: StepPhase; currentAttempt: number }
  >();
  for (const [stepId, phase] of Object.entries(phases)) {
    steps.set(stepId, { stepId, phase, currentAttempt: 1 });
  }
  return {
    runId: "run_test",
    phase: runPhase,
    lastSeq: 0,
    steps,
    children: new Map(),
    pendingTimers: new Map(),
    observedSignalIds: new Set(),
    unconsumedSignals: new Map(),
    consumedMessageIds: new Set(),
  } as unknown as RunState;
}

function toolEnvelope(callId: string, value: unknown): unknown {
  return { callId, content: JSON.stringify(value) };
}

const noop = () => {};

const sourceLists = {
  // artifact_list returns an object wrapper `{ artifacts: [...] }` (matching
  // the hub createListHandler), not a bare array — mirror the real tool shape.
  "list-artifacts": toolEnvelope("c2", {
    artifacts: [{ id: "art_1", title: "Q3 Brief" }],
  }),
  "list-notes": toolEnvelope("c3", {
    notes: [{ id: "note_1", title: "Acme call" }],
    hasMore: false,
  }),
};

// The intake is a 3-page wizard: page 1 (deck fields) → page 2 (source) →
// page 3 (review + submit). These helpers walk it so each test can express
// only the transitions it cares about.
function nextButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
}

// Page 1 → page 2. Fills the deck title and advances once the template has
// seeded (the hub fetch resolves during the awaits, enabling Next).
async function advanceFromDeckFields(title = "Q3 Deck") {
  await userEvent.type(screen.getByLabelText("Deck title"), title);
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
}

// Page 2 → page 3.
async function advanceFromSource() {
  await waitFor(() => expect(nextButton().disabled).toBe(false));
  await userEvent.click(nextButton());
}

describe("artifact → gamma deck Panel", () => {
  it("submits an artifact-sourced intake with the deck title and template", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    screen.getByText("Deck details");
    await advanceFromDeckFields("Q3 Deck");
    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await advanceFromSource();
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({
        artifactId: "art_1",
        deckTitle: "Q3 Deck",
        gammaId: "tmpl_pro",
      }),
    );
  });

  it("parses the full artifact_list row shape (extra columns tolerated)", async () => {
    // The real artifact_list handler returns rows carrying
    // id/title/kind/status/version/updatedAt, not just id/title. The narrow
    // ArtifactItem schema must tolerate those extra columns — otherwise the
    // production payload fails to validate and the picker regresses to
    // "couldn't load", the exact CL-2624 bug. The other fixtures are slim, so
    // this is the one case that proves the fat real payload parses.
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", {
            artifacts: [
              {
                id: "art_full",
                title: "Fat Row",
                kind: "presentation",
                status: "ready",
                version: 3,
                updatedAt: "2026-06-30T00:00:00Z",
              },
            ],
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    screen.getByRole("button", { name: "Fat Row" });
    expect(screen.queryByText(/couldn't load artifacts/i)).toBeNull();
  });

  it("cannot advance past the deck-fields page without a deck title", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    // Template seeds from the hub fetch, but with no deck title Next stays
    // disabled, so the source page (and its tabs) is never reachable.
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Template") as HTMLSelectElement).value,
      ).toBe("tmpl_pro"),
    );
    expect(nextButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Granola call" })).toBeNull();
  });

  it("requires a chosen source before reaching review", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    // On the source page with nothing selected, Next stays disabled.
    expect(nextButton().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Generate deck" })).toBeNull();
  });

  it("submits a pasted-text intake from the paste tab", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Pasted Deck");
    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await userEvent.type(screen.getByLabelText("Pasted text"), "raw notes");
    await advanceFromSource();
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ text: "raw notes", deckTitle: "Pasted Deck" }),
    );
  });

  it("submits a granola-sourced intake from the call tab", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Call Deck");
    await userEvent.click(screen.getByRole("button", { name: "Granola call" }));
    await userEvent.click(screen.getByRole("button", { name: "Acme call" }));
    await advanceFromSource();
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ noteId: "note_1", deckTitle: "Call Deck" }),
    );
  });

  it("lets the user go Back from source to fix the deck title before submitting", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Wrong Title");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    const titleInput = screen.getByLabelText("Deck title") as HTMLInputElement;
    expect(titleInput.value).toBe("Wrong Title");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Right Title");
    await userEvent.click(nextButton());
    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await advanceFromSource();
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ deckTitle: "Right Title" }),
    );
  });

  it("shows a building-the-deck loading state once intake is submitted and generate/render are running", () => {
    // Single-shot (CL-3614): no preview/refine gate between generate and
    // persist — the panel just shows progress while the deck builds.
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({
          intake: "completed",
          generate: "completed",
          render: "in-flight",
        })}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Building the deck in Gamma…");
  });

  it("distinguishes a failed source load from an empty list", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          // A malformed (unparseable) artifacts envelope — an outage, not "no
          // artifacts" — must read as a load failure, not a calm empty state.
          "list-artifacts": { callId: "c2", content: "not json" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    screen.getByText(/couldn't load artifacts/i);
    expect(screen.queryByText("No saved artifacts available.")).toBeNull();
  });

  it("shows a calm empty state (not a load error) when there are no artifacts", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", { artifacts: [] }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    screen.getByText("No saved artifacts available.");
    expect(screen.queryByText(/couldn't load artifacts/i)).toBeNull();
  });

  it("paginates artifacts 10 at a time over the preloaded batch", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `art_${i + 1}`,
      title: `Artifact ${String(i + 1).padStart(2, "0")}`,
    }));
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", { artifacts: many }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    // Page 1 of the list shows the first 10, not the 11th/12th.
    screen.getByRole("button", { name: "Artifact 01" });
    expect(screen.queryByRole("button", { name: "Artifact 11" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    // Page 2 shows the remainder; the first-page items are gone.
    screen.getByRole("button", { name: "Artifact 11" });
    screen.getByRole("button", { name: "Artifact 12" });
    expect(screen.queryByRole("button", { name: "Artifact 01" })).toBeNull();
  });

  it("filters artifacts by title via client-side search", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `art_${i + 1}`,
      title: `Artifact ${String(i + 1).padStart(2, "0")}`,
    }));
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", { artifacts: many }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    await userEvent.type(screen.getByLabelText("Search artifacts"), "11");
    screen.getByRole("button", { name: "Artifact 11" });
    expect(screen.queryByRole("button", { name: "Artifact 01" })).toBeNull();
    // Filtering collapses to a single page — no pagination control.
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("warns that only the 50 most recent artifacts are shown when the list is capped", async () => {
    const capped = Array.from({ length: 50 }, (_, i) => ({
      id: `art_${i + 1}`,
      title: `Artifact ${String(i + 1).padStart(2, "0")}`,
    }));
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", { artifacts: capped }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    screen.getByText(/showing the 50 most recent/i);
  });

  it("does not warn about a cap when the artifact list is below the ceiling", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    expect(screen.queryByText(/showing the 50 most recent/i)).toBeNull();
  });

  it("keeps a selected artifact visible after paging away from it", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: `art_${i + 1}`,
      title: `Artifact ${String(i + 1).padStart(2, "0")}`,
    }));
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={{
          ...sourceLists,
          "list-artifacts": toolEnvelope("c2", { artifacts: many }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    await userEvent.click(screen.getByRole("button", { name: "Artifact 01" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    // The selected item is on page 1, but its selection stays visible on page 2
    // so an off-screen pick can't ship invisibly.
    screen.getByText(/Selected: Artifact 01/);
    expect(screen.queryByRole("button", { name: "Artifact 01" })).toBeNull();
  });

  it("marks the chosen pick-list row with aria-pressed", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    const row = screen.getByRole("button", { name: "Q3 Brief" });
    expect(row.getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(row);
    expect(
      screen
        .getByRole("button", { name: "Q3 Brief" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("offers no search box on the Granola tab", async () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await advanceFromDeckFields("Q3 Deck");
    await userEvent.click(screen.getByRole("button", { name: "Granola call" }));
    screen.getByRole("button", { name: "Acme call" });
    expect(screen.queryByLabelText("Search Granola calls")).toBeNull();
    expect(screen.queryByLabelText("Search artifacts")).toBeNull();
  });

  it("shows the saved-to-workbench done screen once persist completes", () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState(
          { render: "completed", persist: "completed" },
          "completed",
        )}
        connected
        signalPending={false}
        stepOutputs={{
          render: toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Saved to workbench");
    expect(
      screen.getByRole("link", { name: "Open in Gamma" }).getAttribute("href"),
    ).toBe("https://gamma.app/docs/deck-1");
  });

  it("fetches templates from the hub /api/v1 path", async () => {
    const fetchMock = mock((url: string, _init?: RequestInit) => {
      if (String(url).includes("/gamma-templates")) {
        return Promise.resolve(
          jsonResponse([{ gammaId: "tmpl_pro", name: "Investor Deck" }]),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([u]) =>
          String(u).endsWith("/api/v1/gamma-templates"),
        ),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u).includes("/gamma-templates"),
    );
    expect(call).toBeDefined();
    const [url, init] = call!;
    // Base URL prefix (VITE_API_BASE_URL ?? "") + the hub path; credentials
    // ride along so a split-origin deploy still authenticates.
    const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";
    expect(url).toBe(`${apiBase}/api/v1/gamma-templates`);
    expect(init?.credentials).toBe("include");
  });

  it("surfaces a failed template load as the manual-ID fallback, not a silent empty list", async () => {
    globalThis.fetch = mock((url: string) => {
      if (String(url).includes("/gamma-templates")) {
        return Promise.resolve(jsonResponse({ error: "boom" }, 500));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }) as unknown as typeof fetch;
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    await waitFor(() => screen.getByText(/enter a template ID manually/i));
    // A manual-ID input (not the loading placeholder) is offered on failure.
    const input = screen.getByLabelText("Template") as HTMLInputElement;
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("placeholder")).toBe("Gamma template ID");
  });

  it("shows a distinct loading state for the template selector", () => {
    // A never-resolving fetch keeps the query in `isLoading`.
    globalThis.fetch = mock(
      () => new Promise(() => {}),
    ) as unknown as typeof fetch;
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const select = screen.getByLabelText("Template") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.disabled).toBe(true);
    screen.getByText("Loading templates…");
  });

  it("shows the generation-failed banner when the run failed", () => {
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={makeState({ generate: "failed" }, "failed")}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Run failed at Draft");
    screen.getByText(/No error details are available/);
  });

  it("shows the sanitized step error, never raw internals (CL-2659)", () => {
    const state = {
      phase: "failed",
      steps: new Map([
        ["intake", { stepId: "intake", phase: "completed", currentAttempt: 1 }],
        [
          "generate",
          {
            stepId: "generate",
            phase: "failed",
            currentAttempt: 1,
            lastError: {
              message:
                "TypeError: boom at run (ins_01abc/ses_01def) /app/steps/generate.ts:42:7",
            },
          },
        ],
      ]),
    } as unknown as RunState;
    renderPanel(
      <Panel
        logRead={true}
        deploymentId="dep_1"
        state={state}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Run failed at Draft");
    screen.getByText(/Something went wrong inside this workflow run/);
    expect(screen.queryByText(/ins_/)).toBeNull();
    expect(screen.queryByText(/ses_/)).toBeNull();
    expect(screen.queryByText(/TypeError/)).toBeNull();
  });
});
