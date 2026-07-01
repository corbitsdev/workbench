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
    // MAX_ROUNDS comes from the browser-safe constants module instead.
    expect(src).toMatch(/from\s+["']\.\/constants["']/);
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
  "list-artifacts": toolEnvelope("c2", [{ id: "art_1", title: "Q3 Brief" }]),
  "list-notes": toolEnvelope("c3", {
    notes: [{ id: "note_1", title: "Acme call" }],
    hasMore: false,
  }),
};

describe("artifact → gamma deck Panel", () => {
  it("submits an artifact-sourced intake with the deck title and template", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    screen.getByText("Build a deck");
    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await userEvent.type(screen.getByLabelText("Deck title"), "Q3 Deck");
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

  it("does not submit intake without a deck title", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Q3 Brief" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("submits a pasted-text intake from the paste tab", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Paste text" }));
    await userEvent.type(screen.getByLabelText("Pasted text"), "raw notes");
    await userEvent.type(screen.getByLabelText("Deck title"), "Pasted Deck");
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
        deploymentId="dep_1"
        state={makeState({ intake: "awaiting-signal" })}
        connected
        signalPending={false}
        stepOutputs={sourceLists}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Granola call" }));
    await userEvent.click(screen.getByRole("button", { name: "Acme call" }));
    await userEvent.type(screen.getByLabelText("Deck title"), "Call Deck");
    await userEvent.click(
      screen.getByRole("button", { name: "Generate deck" }),
    );

    expect(onSignal).toHaveBeenCalledWith(
      "intake",
      expect.objectContaining({ noteId: "note_1", deckTitle: "Call Deck" }),
    );
  });

  it("shows the rendered deck and approves the round", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    const frame = screen.getByTitle("Generated Gamma presentation");
    expect(frame.getAttribute("src")).toBe("https://gamma.app/docs/deck-1");

    await userEvent.click(
      screen.getByRole("button", { name: "Looks good — approve" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", { approved: true });
  });

  it("sends refine feedback from a non-final round", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    await userEvent.type(
      screen.getByLabelText("Refine feedback"),
      "make it shorter",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Refine with these notes" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", {
      approved: false,
      feedback: "make it shorter",
    });
  });

  it("offers no refine on the final round", () => {
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-3": "completed",
          "preview-3": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-3": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-3",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("This is the final draft — approve to save it.");
    expect(
      screen.queryByRole("button", { name: "Refine with these notes" }),
    ).toBeNull();
  });

  it("disables approval while a signal is pending", () => {
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={true}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    const button = screen.getByRole("button", {
      name: "Looks good — approve",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("does not render an unsafe (non-https) deck url but keeps the gate answerable", async () => {
    const onSignal = mock(() => {});
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "render-1": "completed",
          "preview-1": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", { gammaUrl: "http://insecure/deck" }),
        }}
        onSignal={onSignal}
        onClose={noop}
      />,
    );

    // No iframe for an unsafe URL, and no "Open in Gamma" link to it...
    expect(screen.queryByTitle("Generated Gamma presentation")).toBeNull();
    expect(screen.queryByRole("link", { name: "Open in Gamma" })).toBeNull();
    screen.getByText(/deck preview couldn't be loaded/i);
    // ...but the preview gate is still answerable so the run can't deadlock.
    await userEvent.click(
      screen.getByRole("button", { name: "Looks good — approve" }),
    );
    expect(onSignal).toHaveBeenCalledWith("preview-1", { approved: true });
  });

  it("resolves the approved round, not a gate-skipped later round, on the done screen", () => {
    // Approving round 1 prunes rounds 2-3; the gate commits a real
    // StepCompleted (phase `completed`) with a `{ skipped: true }` sentinel for
    // every pruned step, including persist-2/persist-3. The done screen must
    // resolve to the round that actually persisted (1) and show ITS deck — not
    // the highest completed persist (a skipped 3 with no rendered deck).
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          {
            "render-1": "completed",
            "persist-1": "completed",
            "render-3": "completed",
            "persist-2": "completed",
            "persist-3": "completed",
          },
          "completed",
        )}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
          "persist-1": toolEnvelope("c5", { artifactId: "art_out" }),
          "persist-2": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-2",
          },
          "persist-3": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-3",
          },
          "render-3": { skipped: true, gateId: "check-1", branch: "render-3" },
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Saved to workbench");
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
    ).toBe("https://gamma.app/docs/deck-1");
  });

  it("stays on the preview during a refine even though the pruned persist is completed", () => {
    // Refusing round 1 routes to generate-2 and prunes the persist-1 branch, so
    // persist-1 lands in `completed` with a skip sentinel. The panel must NOT
    // mistake that for a finished run and show the done screen mid-refine.
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState({
          "persist-1": "completed",
          "render-2": "completed",
          "preview-2": "awaiting-signal",
        })}
        connected
        signalPending={false}
        stepOutputs={{
          "persist-1": {
            skipped: true,
            gateId: "check-1",
            branch: "persist-1",
          },
          "render-2": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-2",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    expect(screen.queryByText("Saved to workbench")).toBeNull();
    screen.getByRole("button", { name: "Looks good — approve" });
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
    ).toBe("https://gamma.app/docs/deck-2");
  });

  it("distinguishes a failed source load from an empty list", () => {
    renderPanel(
      <Panel
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

    screen.getByText(/couldn't load artifacts/i);
    expect(screen.queryByText("No saved artifacts available.")).toBeNull();
  });

  it("shows the saved-to-workbench done screen once a round is persisted", () => {
    renderPanel(
      <Panel
        deploymentId="dep_1"
        state={makeState(
          { "render-1": "completed", "persist-1": "completed" },
          "completed",
        )}
        connected
        signalPending={false}
        stepOutputs={{
          "render-1": toolEnvelope("c4", {
            gammaUrl: "https://gamma.app/docs/deck-1",
          }),
        }}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Saved to workbench");
    expect(
      screen.getByTitle("Generated Gamma presentation").getAttribute("src"),
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
    expect(url).toBe("/api/v1/gamma-templates");
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
        deploymentId="dep_1"
        state={makeState({ "generate-1": "failed" }, "failed")}
        connected
        signalPending={false}
        stepOutputs={{}}
        onSignal={noop}
        onClose={noop}
      />,
    );

    screen.getByText("Generation failed");
  });
});
