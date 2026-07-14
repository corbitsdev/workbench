import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { type } from "arktype";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  FailedRunNotice,
  HorizontalStepper,
  inputFieldClass,
  LiveStatusSlot,
  liveStatusLabel,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState, StepState } from "@intx/workflow";
// From ./display-steps, NOT ./index: importing the server-only workflow
// definition here would pull @intx/agent into the browser `/ui` chunk and
// break panel load. ./display-steps is browser-safe and is the single source
// of truth shared with the server catalog preview.
import { DISPLAY_STEPS } from "./display-steps";
import { AUDIENCE_OPTIONS, TONE_OPTIONS, GOAL_OPTIONS } from "./intake-defaults";

type StepPhase = StepState["phase"];

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
  "systemPrompt?": "string",
});
const TemplateArray = TemplateItem.array();

const ArtifactItem = type({ id: "string", "title?": "string | null" });
// artifact_list returns an object wrapper `{ artifacts: [...] }` (hub
// createListHandler), mirroring granola_list_notes' `{ notes: [...] }` — not a
// bare array. Parsing it as a bare array made every real payload fail to
// validate, surfacing as "couldn't load artifacts" (CL-2624).
const ArtifactListResult = type({ artifacts: ArtifactItem.array() });

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

type Option = { id: string; title: string; systemPrompt?: string };

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
      return parsed.map((t) => ({
        id: t.gammaId,
        title: t.name,
        ...(t.systemPrompt ? { systemPrompt: t.systemPrompt } : {}),
      }));
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
    options: parsed.artifacts.map((a) => ({
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

function readRenderURL(stepOutputs: Record<string, unknown>): string | undefined {
  const inner = peelEnvelope(stepOutputs["render"]);
  if (inner === undefined) return undefined;
  const parsed = GammaResult(inner);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.gammaUrl) ?? readString(parsed.url);
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
  templateSystemPrompt?: string;
  artifactId?: string;
  noteId?: string;
  text?: string;
};

const OTHER_OPTION = "__other__";

// A "pick a preset, or type your own" control: a <select> with a leading
// empty option (no preference), the preset list, and a trailing "Other…"
// entry that reveals a free-text input. The submitted value is either the
// chosen preset or the custom text — both optional.
function PresetSelect({
  label,
  ariaLabel,
  options,
  value,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  options: readonly string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const isCustom = value !== "" && !options.includes(value);
  const [customMode, setCustomMode] = useState(isCustom);
  const showCustom = customMode || (value !== "" && !options.includes(value));
  const selectValue = showCustom ? OTHER_OPTION : value;

  return (
    <label className="block space-y-1">
      <span className="text-[12px] text-text-3">{label}</span>
      <select
        aria-label={ariaLabel}
        value={selectValue}
        onChange={(e) => {
          const next = e.target.value;
          if (next === OTHER_OPTION) {
            setCustomMode(true);
            onChange("");
            return;
          }
          setCustomMode(false);
          onChange(next);
        }}
        className={inputFieldClass}
      >
        <option value="">No preference</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
        <option value={OTHER_OPTION}>Other…</option>
      </select>
      {showCustom && (
        <input
          aria-label={`${ariaLabel} (custom)`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type your own"
          className={inputFieldClass}
          autoFocus
        />
      )}
    </label>
  );
}

// Sources are preloaded by the list steps and paginated client-side here — the
// workflow DAG is acyclic/fire-once, so there is no "fetch the next page"
// round-trip; the panel slices what it already holds. The preload is capped by
// the tool (artifacts 50, Granola 30), so `capNote` warns when the list is at
// that ceiling — search/paging only cover the loaded window, and older sources
// won't appear (use paste text for those).
const SOURCE_PAGE_SIZE = 10;

// Tool-side caps on the preload (see index.ts argMap + each tool's MAX_LIST_LIMIT):
// artifact_list allows 50, granola_list_notes clamps to 30.
const ARTIFACT_PRELOAD = 50;
const NOTE_PRELOAD = 30;

const pageButtonClass =
  "min-h-[40px] rounded-[8px] px-3 py-2 transition-transform enabled:hover:text-text-2 enabled:active:scale-[0.97] disabled:opacity-40 motion-reduce:enabled:active:scale-100";

function PaginatedPickList({
  options,
  selected,
  onSelect,
  empty,
  failed,
  failedLabel,
  searchLabel,
  capNote,
}: {
  options: Option[];
  selected: string;
  onSelect: (id: string) => void;
  empty: string;
  failed: boolean;
  failedLabel: string;
  // When set, renders a client-side title filter with this aria-label.
  searchLabel?: string;
  // When set (list is at the preload ceiling), a muted "showing the N most
  // recent" note so a bounded search/list never reads as the whole corpus.
  // `| undefined` so callers can pass the computed value directly under
  // exactOptionalPropertyTypes.
  capNote?: string | undefined;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);

  if (failed) {
    return (
      <p className="text-sm text-text-2" role="status">
        {failedLabel}
      </p>
    );
  }

  const trimmed = query.trim().toLowerCase();
  const filtered =
    searchLabel && trimmed
      ? options.filter((o) => o.title.toLowerCase().includes(trimmed))
      : options;
  const pageCount = Math.max(1, Math.ceil(filtered.length / SOURCE_PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const start = clampedPage * SOURCE_PAGE_SIZE;
  const visible = filtered.slice(start, start + SOURCE_PAGE_SIZE);
  const selectedTitle = options.find((o) => o.id === selected)?.title;

  const search = searchLabel ? (
    <input
      aria-label={searchLabel}
      value={query}
      onChange={(e) => {
        setQuery(e.target.value);
        setPage(0);
      }}
      placeholder="Search by title"
      className={inputFieldClass}
    />
  ) : null;

  const capHint = capNote ? (
    <p className="text-[12px] text-text-3">{capNote}</p>
  ) : null;

  if (filtered.length === 0) {
    return (
      <div className="space-y-2">
        {search}
        <p className="text-sm text-text-3">{trimmed ? "No matches." : empty}</p>
        {capHint}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {search}
      {/* A selection made on one page stays visible after paging away, so an
          off-screen pick can never ship invisibly. */}
      {selectedTitle && (
        <p className="text-[12px] text-text-2">Selected: {selectedTitle}</p>
      )}
      <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-surface">
        {visible.map((o) => (
          <li key={o.id}>
            <button
              type="button"
              aria-pressed={selected === o.id}
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
      {capHint}
      {pageCount > 1 && (
        <div className="flex items-center justify-between text-[12px] text-text-3">
          <button
            type="button"
            aria-label="Previous page"
            disabled={clampedPage === 0}
            onClick={() => setPage(clampedPage - 1)}
            className={pageButtonClass}
          >
            Prev
          </button>
          <span className="tabular-nums" aria-live="polite">
            Page {clampedPage + 1} of {pageCount}
          </span>
          <button
            type="button"
            aria-label="Next page"
            disabled={clampedPage >= pageCount - 1}
            onClick={() => setPage(clampedPage + 1)}
            className={pageButtonClass}
          >
            Next
          </button>
        </div>
      )}
    </div>
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

  const [page, setPage] = useState<1 | 2 | 3>(1);
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
  const deckFieldsReady =
    gammaId.trim().length > 0 && deckTitle.trim().length > 0;
  const canSubmit =
    connected && !signalPending && deckFieldsReady && sourceChosen;

  const tabClass = (t: SourceTab) =>
    `min-h-[40px] rounded-[8px] px-3 py-2 text-[12px] transition-[background-color,color,transform] active:scale-[0.97] motion-reduce:active:scale-100 ${
      tab === t ? "bg-surface-2 text-text" : "text-text-3 hover:text-text-2"
    }`;

  // The preload is capped by each tool (artifacts 50, Granola 30). When the
  // loaded list is at that ceiling, warn that search/paging only cover the
  // loaded window (older sources → paste text).
  const artifactCapNote =
    artifacts.options.length >= ARTIFACT_PRELOAD
      ? "Showing the 50 most recent — search covers only these. For older artifacts, paste the text."
      : undefined;
  const noteCapNote =
    notes.options.length >= NOTE_PRELOAD
      ? "Showing the 30 most recent Granola calls. For older calls, paste the text."
      : undefined;

  const pageTitle = { 1: "Deck details", 2: "Choose a source", 3: "Review" }[
    page
  ];

  const templateName =
    templates.options.find((t) => t.id === gammaId)?.title ?? gammaId;
  const sourceSummary = (() => {
    if (tab === "artifact") {
      return artifacts.options.find((o) => o.id === artifactId)?.title ?? "—";
    }
    if (tab === "granola") {
      return notes.options.find((o) => o.id === noteId)?.title ?? "—";
    }
    return "Pasted text";
  })();

  const selectedTemplateSystemPrompt = templates.options.find(
    (t) => t.id === gammaId,
  )?.systemPrompt;

  function submit() {
    if (!canSubmit) return;
    const base = {
      deckTitle: deckTitle.trim(),
      gammaId: gammaId.trim(),
      audience: audience.trim(),
      tone: tone.trim(),
      goal: goal.trim(),
      ...(selectedTemplateSystemPrompt
        ? { templateSystemPrompt: selectedTemplateSystemPrompt }
        : {}),
    };
    if (tab === "artifact") onSubmit({ ...base, artifactId });
    else if (tab === "granola") onSubmit({ ...base, noteId });
    else onSubmit({ ...base, text: text.trim() });
  }

  return (
    <Card>
      <CardTitle>{pageTitle}</CardTitle>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {page === 1 && (
          <>
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
            <PresetSelect
              label="Audience (optional)"
              ariaLabel="Audience"
              options={AUDIENCE_OPTIONS}
              value={audience}
              onChange={setAudience}
            />
            <PresetSelect
              label="Tone (optional)"
              ariaLabel="Tone"
              options={TONE_OPTIONS}
              value={tone}
              onChange={setTone}
            />
            <PresetSelect
              label="Goal (optional)"
              ariaLabel="Goal"
              options={GOAL_OPTIONS}
              value={goal}
              onChange={setGoal}
            />

            <div className="flex justify-end">
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!deckFieldsReady}
                onClick={() => setPage(2)}
              >
                Next
              </Button>
            </div>
          </>
        )}

        {page === 2 && (
          <>
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
                <PaginatedPickList
                  options={artifacts.options}
                  selected={artifactId}
                  onSelect={setArtifactId}
                  empty="No saved artifacts available."
                  failed={artifacts.failed}
                  failedLabel="Couldn't load artifacts — the integration may be unavailable. Try a Granola call or paste text."
                  searchLabel="Search artifacts"
                  capNote={artifactCapNote}
                />
              )}
              {tab === "granola" && (
                <PaginatedPickList
                  options={notes.options}
                  selected={noteId}
                  onSelect={setNoteId}
                  empty="No Granola calls available."
                  failed={notes.failed}
                  failedLabel="Couldn't load Granola calls — the integration may be unavailable. Try an artifact or paste text."
                  capNote={noteCapNote}
                />
              )}
              {/* Granola has no search box: the tool caps the preload at 30,
                  so a title filter over that small window would hide more than
                  it helps — paste text is the escape hatch for older calls. */}
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

            <div className="flex justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage(1)}
              >
                Back
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!sourceChosen}
                onClick={() => setPage(3)}
              >
                Next
              </Button>
            </div>
          </>
        )}

        {page === 3 && (
          <>
            {/* The deck title leads as the review's anchor; the rest is
                supporting config in a muted key/value list below it. */}
            <div className="space-y-1">
              <span className="text-[12px] text-text-3">Deck title</span>
              <p className="text-base font-medium text-text">
                {deckTitle.trim()}
              </p>
            </div>
            <dl className="space-y-2 text-[13px]">
              <div className="flex justify-between gap-4">
                <dt className="text-text-3">Template</dt>
                <dd className="text-text">{templateName}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-text-3">Source</dt>
                <dd className="text-text">{sourceSummary}</dd>
              </div>
              {audience.trim() && (
                <div className="flex justify-between gap-4">
                  <dt className="text-text-3">Audience</dt>
                  <dd className="text-text">{audience.trim()}</dd>
                </div>
              )}
              {tone.trim() && (
                <div className="flex justify-between gap-4">
                  <dt className="text-text-3">Tone</dt>
                  <dd className="text-text">{tone.trim()}</dd>
                </div>
              )}
              {goal.trim() && (
                <div className="flex justify-between gap-4">
                  <dt className="text-text-3">Goal</dt>
                  <dd className="text-text">{goal.trim()}</dd>
                </div>
              )}
            </dl>

            <div className="flex justify-between">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPage(2)}
              >
                Back
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!canSubmit}
              >
                Generate deck
              </Button>
            </div>
            {!connected && (
              <p className="text-xs text-text-3">
                Reconnecting — input unavailable.
              </p>
            )}
          </>
        )}
      </form>
    </Card>
  );
}

function DoneScreen({
  stepOutputs,
  onClose,
}: {
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  const url = readRenderURL(stepOutputs);
  const safeUrl = isSafePresentationURL(url) ? url : undefined;
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-sm font-medium text-text">Saved to workbench</p>
        <p className="mt-1 text-sm text-text-3">
          The approved deck is saved as a presentation artifact.
        </p>
        <div className="mt-4 flex items-center gap-3">
          {safeUrl !== undefined && (
            <a
              href={safeUrl}
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

  const done = phaseFor(state, "persist") === "completed";
  const intakeAwaiting = phaseFor(state, "intake") === "awaiting-signal";
  const group = activeDisplayStep(state, DISPLAY_STEPS)?.key;

  function body(): ReactNode {
    if (failed) {
      return (
        <div className="space-y-4">
          <FailedRunNotice
            state={state}
            steps={DISPLAY_STEPS}
            logRead={props.logRead}
          />
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      );
    }
    if (done) {
      return <DoneScreen stepOutputs={stepOutputs} onClose={onClose} />;
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
    if (group === "done") {
      return <LoadingState label="Saving to workbench…" />;
    }
    return <LoadingState label="Loading sources…" />;
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
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
