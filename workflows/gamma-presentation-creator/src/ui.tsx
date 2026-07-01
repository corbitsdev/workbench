import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  type DisplayStep,
  HorizontalStepper,
  inputFieldClass,
  LiveStatusSlot,
  liveStatusLabel,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState, StepState } from "@intx/workflow";
// From ./constants, NOT ./index: importing the server-only workflow definition
// here would pull @intx/agent into the browser `/ui` chunk and break panel load.
import { MAX_ROUNDS } from "./constants";

type StepPhase = StepState["phase"];

const ROUNDS = Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1);

// Four display steps cluster the repeating per-round runtime steps. The
// machine-work groups carry a verb `activityLabel` for the live status line;
// the source and review groups carry none (they wait on the user).
const DISPLAY_STEPS: DisplayStep[] = [
  {
    key: "source",
    label: "Source",
    stepIds: [
      "list-artifacts",
      "list-notes",
      "intake",
      "fetch-artifact",
      "fetch-note",
    ],
  },
  {
    key: "draft",
    label: "Draft",
    stepIds: ROUNDS.flatMap((r) => [`generate-${r}`, `render-${r}`]),
    activityLabel: "Building the deck",
  },
  {
    key: "review",
    label: "Review",
    stepIds: ROUNDS.map((r) => `preview-${r}`),
  },
  {
    key: "done",
    label: "Done",
    stepIds: ROUNDS.map((r) => `persist-${r}`),
    activityLabel: "Saving to workbench",
  },
];

function phaseFor(
  state: RunState | null,
  stepId: string,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

// ── Output parsing ────────────────────────────────────────────────────────────

const ToolResultEnvelope = type({ "callId?": "string", content: "string" });

// The hub's GET /gamma-templates item. The selector needs only gammaId + name;
// the remaining fields are tolerated so a richer payload still parses.
const TemplateItem = type({
  gammaId: "string",
  name: "string",
  "description?": "string",
});
const TemplateArray = TemplateItem.array();

const ArtifactItem = type({ id: "string", "title?": "string | null" });
const ArtifactListResult = ArtifactItem.array();

const NoteItem = type({ id: "string", "title?": "string | null" });
const NotesResult = type({ notes: NoteItem.array() });

const GammaResult = type({ "gammaUrl?": "string", "url?": "string" });

function peelEnvelope(raw: unknown): unknown {
  const envelope = ToolResultEnvelope(raw);
  if (envelope instanceof type.errors) return undefined;
  try {
    return JSON.parse(envelope.content);
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

type Option = { id: string; title: string };

// `failed` distinguishes "the source tool errored / returned a shape we can't
// read" from a genuinely empty list, so the UI can say "couldn't load" instead
// of silently presenting an outage as "you have nothing."
type OptionLoad = { options: Option[]; failed: boolean };

type TemplateOptions = { options: Option[]; failed: boolean; loading: boolean };

// The hub base URL — mirrors apps/web/src/lib/api.ts. Empty string means
// same-origin; a split-origin deploy sets VITE_API_BASE_URL so this UI hits the
// hub (and sends its cookie) rather than the web app's own origin.
const apiBase: string = import.meta.env.VITE_API_BASE_URL ?? "";

// Templates now come from the hub (GET /gamma-templates) rather than a workflow
// step — the `list-templates` step was removed because it crashed deploys. The
// custom Panel always renders inside the app's QueryClientProvider, so a
// fetch via TanStack Query is the layering-correct path (this leaf package can't
// import apps/web's `api` client). Catalog data → 5-min staleTime.
function useTemplateOptions(): TemplateOptions {
  const query = useQuery({
    queryKey: ["gamma-templates", null],
    queryFn: async (): Promise<Option[]> => {
      const res = await fetch(`${apiBase}/api/v1/gamma-templates`, {
        credentials: "include",
      });
      if (!res.ok) {
        throw new Error(`Failed to load templates: HTTP ${res.status}`);
      }
      const raw: unknown = await res.json();
      const parsed = TemplateArray(raw);
      if (parsed instanceof type.errors) {
        throw new Error(parsed.summary);
      }
      return parsed.map((t) => ({ id: t.gammaId, title: t.name }));
    },
    staleTime: 5 * 60_000,
  });
  return {
    options: query.data ?? [],
    failed: query.isError,
    loading: query.isLoading,
  };
}

function readArtifactOptions(stepOutputs: Record<string, unknown>): OptionLoad {
  const inner = peelEnvelope(stepOutputs["list-artifacts"]);
  if (inner === undefined) return { options: [], failed: true };
  const parsed = ArtifactListResult(inner);
  if (parsed instanceof type.errors) return { options: [], failed: true };
  return {
    options: parsed.map((a) => ({
      id: a.id,
      title: readString(a.title) ?? a.id,
    })),
    failed: false,
  };
}

function readNoteOptions(stepOutputs: Record<string, unknown>): OptionLoad {
  const inner = peelEnvelope(stepOutputs["list-notes"]);
  if (inner === undefined) return { options: [], failed: true };
  const parsed = NotesResult(inner);
  if (parsed instanceof type.errors) return { options: [], failed: true };
  return {
    options: parsed.notes.map((n) => ({
      id: n.id,
      title: readString(n.title) ?? n.id,
    })),
    failed: false,
  };
}

function isSafePresentationURL(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function readRenderURL(
  stepOutputs: Record<string, unknown>,
  round: number,
): string | undefined {
  const inner = peelEnvelope(stepOutputs[`render-${round}`]);
  if (inner === undefined) return undefined;
  const parsed = GammaResult(inner);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.gammaUrl) ?? readString(parsed.url);
}

// ── Routing helpers ───────────────────────────────────────────────────────────

function awaitingPreviewRound(state: RunState | null): number | undefined {
  return ROUNDS.find(
    (r) => phaseFor(state, `preview-${r}`) === "awaiting-signal",
  );
}

// A gate prunes the not-selected branch by committing a `{ skipped: true }`
// sentinel and a real `StepCompleted` for every step in its closure (the
// runtime has no `skipped` phase — pruned steps land in `completed`). So a
// persist step in a pruned round reads as `completed` too; we must ignore it,
// or an early approval/refine would resolve to the wrong round (showing the
// Done screen mid-refine, or reading a never-rendered deck URL).
function isSkippedOutput(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).skipped === true
  );
}

function persistedRound(
  state: RunState | null,
  stepOutputs: Record<string, unknown>,
): number | undefined {
  return ROUNDS.find(
    (r) =>
      phaseFor(state, `persist-${r}`) === "completed" &&
      !isSkippedOutput(stepOutputs[`persist-${r}`]),
  );
}

// ── Shared layout ─────────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-[14px] border border-border bg-surface p-6 shadow-sm">
      {children}
    </section>
  );
}

function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="mb-4 text-sm font-medium text-text">{children}</h3>;
}

function LoadingState({ label }: { label: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3 text-sm text-text-3">
        <span
          aria-hidden
          className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-border border-t-orange motion-reduce:animate-none"
        />
        <span>{label}</span>
      </div>
    </Card>
  );
}

function DeckFrame({ url }: { url: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
        <iframe
          src={url}
          allow="fullscreen"
          sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"
          className="absolute inset-0 h-full w-full border-0"
          title="Generated Gamma presentation"
        />
      </div>
    </div>
  );
}

// External Gamma links can't be a <Button> (they navigate), so match the
// secondary Button treatment here for a consistent affordance + hit area.
const linkButtonClass =
  "inline-flex items-center justify-center rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-medium text-text transition-colors hover:bg-surface-2 active:scale-[0.97] motion-reduce:active:scale-100";

// ── Intake ────────────────────────────────────────────────────────────────────

type SourceTab = "artifact" | "granola" | "paste";

type IntakePayload = {
  deckTitle: string;
  gammaId: string;
  audience: string;
  tone: string;
  goal: string;
  artifactId?: string;
  noteId?: string;
  text?: string;
};

function PickList({
  options,
  selected,
  onSelect,
  empty,
  failed,
  failedLabel,
}: {
  options: Option[];
  selected: string;
  onSelect: (id: string) => void;
  empty: string;
  failed: boolean;
  failedLabel: string;
}) {
  if (failed) {
    return (
      <p className="text-sm text-text-2" role="status">
        {failedLabel}
      </p>
    );
  }
  if (options.length === 0) {
    return <p className="text-sm text-text-3">{empty}</p>;
  }
  return (
    <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface">
      {options.map((o) => (
        <li key={o.id}>
          <button
            type="button"
            onClick={() => onSelect(o.id)}
            className={`block w-full px-3 py-2 text-left text-[13px] transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 ${
              selected === o.id ? "bg-surface-2 text-text" : "text-text-2"
            }`}
          >
            {o.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

function IntakeScreen({
  phase,
  connected,
  signalPending,
  stepOutputs,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  stepOutputs: Record<string, unknown>;
  onSubmit: (payload: IntakePayload) => void;
}) {
  const templates = useTemplateOptions();
  const artifacts = readArtifactOptions(stepOutputs);
  const notes = readNoteOptions(stepOutputs);

  const [tab, setTab] = useState<SourceTab>("artifact");
  const [gammaId, setGammaId] = useState("");
  const [userPickedTemplate, setUserPickedTemplate] = useState(false);
  const [deckTitle, setDeckTitle] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [goal, setGoal] = useState("");
  const [artifactId, setArtifactId] = useState("");
  const [noteId, setNoteId] = useState("");
  const [text, setText] = useState("");

  const firstTemplateId = templates.options[0]?.id ?? "";
  // Single source of truth for the selection: seed it from the first loaded
  // template once options arrive, then leave it alone. This is state-seeding,
  // not data fetching, so it does not fall under the no-useEffect-fetch rule. A
  // user's explicit pick sets `userPickedTemplate`, which locks the seed out so
  // a later refetch can never clobber their choice.
  useEffect(() => {
    if (userPickedTemplate) return;
    if (gammaId === "" && firstTemplateId !== "") setGammaId(firstTemplateId);
  }, [firstTemplateId, gammaId, userPickedTemplate]);

  function pickTemplate(id: string) {
    setUserPickedTemplate(true);
    setGammaId(id);
  }

  // Only one source feeds a run; clear the others on switch so the attached
  // source is always exactly what the visible tab shows (no invisible
  // cross-tab selection riding along on submit).
  function selectTab(next: SourceTab) {
    setTab(next);
    if (next !== "artifact") setArtifactId("");
    if (next !== "granola") setNoteId("");
    if (next !== "paste") setText("");
  }

  if (phase !== "awaiting-signal") {
    return <LoadingState label="Loading sources…" />;
  }

  const sourceChosen =
    (tab === "artifact" && artifactId.length > 0) ||
    (tab === "granola" && noteId.length > 0) ||
    (tab === "paste" && text.trim().length > 0);
  const canSubmit =
    connected &&
    !signalPending &&
    gammaId.trim().length > 0 &&
    deckTitle.trim().length > 0 &&
    sourceChosen;

  const tabClass = (t: SourceTab) =>
    `rounded-[8px] px-3 py-1.5 text-[12px] ${
      tab === t ? "bg-surface-2 text-text" : "text-text-3 hover:text-text-2"
    }`;

  return (
    <Card>
      <CardTitle>Build a deck</CardTitle>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          const base = {
            deckTitle: deckTitle.trim(),
            gammaId: gammaId.trim(),
            audience: audience.trim(),
            tone: tone.trim(),
            goal: goal.trim(),
          };
          if (tab === "artifact") onSubmit({ ...base, artifactId });
          else if (tab === "granola") onSubmit({ ...base, noteId });
          else onSubmit({ ...base, text: text.trim() });
        }}
      >
        <div className="space-y-2">
          <span className="text-[12px] text-text-3">Source</span>
          <div className="flex gap-2">
            <button
              type="button"
              className={tabClass("artifact")}
              onClick={() => selectTab("artifact")}
            >
              Artifact
            </button>
            <button
              type="button"
              className={tabClass("granola")}
              onClick={() => selectTab("granola")}
            >
              Granola call
            </button>
            <button
              type="button"
              className={tabClass("paste")}
              onClick={() => selectTab("paste")}
            >
              Paste text
            </button>
          </div>
          {tab === "artifact" && (
            <PickList
              options={artifacts.options}
              selected={artifactId}
              onSelect={setArtifactId}
              empty="No saved artifacts available."
              failed={artifacts.failed}
              failedLabel="Couldn't load artifacts — the integration may be unavailable. Try a Granola call or paste text."
            />
          )}
          {tab === "granola" && (
            <PickList
              options={notes.options}
              selected={noteId}
              onSelect={setNoteId}
              empty="No Granola calls available."
              failed={notes.failed}
              failedLabel="Couldn't load Granola calls — the integration may be unavailable. Try an artifact or paste text."
            />
          )}
          {tab === "paste" && (
            <textarea
              aria-label="Pasted text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder="Paste the source text for the deck"
              className={inputFieldClass}
            />
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Deck title</span>
          <input
            aria-label="Deck title"
            value={deckTitle}
            onChange={(e) => setDeckTitle(e.target.value)}
            className={inputFieldClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Template</span>
          {templates.loading && (
            <select
              aria-label="Template"
              disabled
              value=""
              className={inputFieldClass}
            >
              <option value="">Loading templates…</option>
            </select>
          )}
          {!templates.loading && templates.options.length > 0 && (
            <select
              aria-label="Template"
              value={gammaId}
              onChange={(e) => pickTemplate(e.target.value)}
              className={inputFieldClass}
            >
              {templates.options.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          )}
          {!templates.loading && templates.options.length === 0 && (
            <input
              aria-label="Template"
              value={gammaId}
              onChange={(e) => pickTemplate(e.target.value)}
              placeholder="Gamma template ID"
              className={inputFieldClass}
            />
          )}
          {templates.failed && (
            <span className="block text-[12px] text-text-2" role="status">
              Couldn't load templates — enter a template ID manually.
            </span>
          )}
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Audience</span>
          <input
            aria-label="Audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            className={inputFieldClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Tone</span>
          <input
            aria-label="Tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
            className={inputFieldClass}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] text-text-3">Goal</span>
          <input
            aria-label="Goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            className={inputFieldClass}
          />
        </label>

        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
          Generate deck
        </Button>
        {!connected && (
          <p className="text-xs text-text-3">
            Reconnecting — input unavailable.
          </p>
        )}
      </form>
    </Card>
  );
}

// ── Per-round preview ───────────────────────────────────────────────────────────

function PreviewScreen({
  round,
  connected,
  signalPending,
  stepOutputs,
  onSignal,
}: {
  round: number;
  connected: boolean;
  signalPending: boolean;
  stepOutputs: Record<string, unknown>;
  onSignal: (name: string, payload: Record<string, unknown>) => void;
}) {
  const url = readRenderURL(stepOutputs, round);
  const safeUrl = isSafePresentationURL(url) ? url : undefined;
  const canRefine = round < MAX_ROUNDS;
  const [feedback, setFeedback] = useState("");
  const disabled = !connected || signalPending;

  // Even when the rendered URL is unusable we keep the controls on screen — the
  // preview gate is still open server-side, so the user must be able to refine
  // (regenerate) or, on the last round, approve. Returning only an error here
  // would strand the run at an unanswerable gate.
  return (
    <div className="space-y-4">
      {safeUrl ? (
        <DeckFrame url={safeUrl} />
      ) : (
        <Card>
          <p className="text-sm text-text-2">
            The deck preview couldn't be loaded.{" "}
            {canRefine
              ? "Refine to regenerate it, or open it in Gamma if a link is available."
              : "You can still approve to save this draft, or open it in Gamma."}
          </p>
        </Card>
      )}
      <Card>
        <CardTitle>
          <span className="tabular-nums">
            Draft {round} of up to {MAX_ROUNDS}
          </span>
        </CardTitle>
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              disabled={disabled}
              onClick={() => onSignal(`preview-${round}`, { approved: true })}
            >
              Looks good — approve
            </Button>
            {safeUrl && (
              <a
                href={safeUrl}
                target="_blank"
                rel="noreferrer"
                className={linkButtonClass}
              >
                Open in Gamma
              </a>
            )}
          </div>
          {canRefine ? (
            <div className="space-y-2">
              <textarea
                aria-label="Refine feedback"
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                rows={3}
                placeholder="What should change? The next draft will revise from this."
                className={inputFieldClass}
              />
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || feedback.trim().length === 0}
                onClick={() =>
                  onSignal(`preview-${round}`, {
                    approved: false,
                    feedback: feedback.trim(),
                  })
                }
              >
                Refine with these notes
              </Button>
            </div>
          ) : (
            <p className="text-xs text-text-3">
              This is the final draft — approve to save it.
            </p>
          )}
          {!connected && (
            <p className="text-xs text-text-3">
              Reconnecting — input unavailable.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function DoneScreen({
  round,
  stepOutputs,
  onClose,
}: {
  round: number;
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  const url = readRenderURL(stepOutputs, round);
  return (
    <div className="space-y-4">
      {isSafePresentationURL(url) && <DeckFrame url={url} />}
      <Card>
        <p className="text-sm font-medium text-text">Saved to workbench</p>
        <p className="mt-1 text-sm text-text-3">
          The approved deck is saved as a presentation artifact.
        </p>
        <div className="mt-4 flex items-center gap-3">
          {isSafePresentationURL(url) && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className={linkButtonClass}
            >
              Open in Gamma
            </a>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, signalPending, stepOutputs, onSignal, onClose } =
    props;
  const failed = state?.phase === "failed";
  const liveLabel = liveStatusLabel(state, DISPLAY_STEPS);

  const done = persistedRound(state, stepOutputs);
  const previewRound = awaitingPreviewRound(state);
  const intakeAwaiting = phaseFor(state, "intake") === "awaiting-signal";
  const group = activeDisplayStep(state, DISPLAY_STEPS)?.key;

  function body(): ReactNode {
    if (failed) {
      return (
        <Card>
          <p className="text-sm font-medium text-text">Generation failed</p>
          <p className="mt-1 text-sm text-text-3">
            The deck could not be generated. Close this run and start a new one
            to try again.
          </p>
          <div className="mt-4">
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </Card>
      );
    }
    if (done !== undefined) {
      return (
        <DoneScreen round={done} stepOutputs={stepOutputs} onClose={onClose} />
      );
    }
    if (previewRound !== undefined) {
      return (
        <PreviewScreen
          round={previewRound}
          connected={connected}
          signalPending={signalPending}
          stepOutputs={stepOutputs}
          onSignal={onSignal}
        />
      );
    }
    if (intakeAwaiting) {
      return (
        <IntakeScreen
          phase={phaseFor(state, "intake")}
          connected={connected}
          signalPending={signalPending}
          stepOutputs={stepOutputs}
          onSubmit={(payload) => onSignal("intake", payload)}
        />
      );
    }
    if (group === "draft") {
      return <LoadingState label="Building the deck in Gamma…" />;
    }
    return <LoadingState label="Loading sources…" />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">
            Gamma Presentation
          </h2>
          <p className="text-xs text-text-3">
            Turn an artifact, call, or pasted text into a deck
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          aria-label="Close panel"
        >
          Close
        </Button>
      </header>

      <HorizontalStepper steps={buildStepperSteps(state)} />
      <LiveStatusSlot label={liveLabel} />

      <div className="flex-1 overflow-y-auto p-6">{body()}</div>
    </div>
  );
}
