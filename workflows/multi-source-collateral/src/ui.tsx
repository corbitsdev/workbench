import { useMemo, useState, type ReactNode } from "react";
import {
  activeDisplayStepIndex,
  buildRunStepperSteps,
  Button,
  FailedRunNotice,
  HorizontalStepper,
  LiveStatusSlot,
  liveStatusLabel,
  Markdown,
  type WorkflowPanelProps,
  workflowPanelShowsShellHeader,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState } from "@intx/workflow";
import { DISPLAY_STEPS } from "./display-steps";
import {
  buildSourceContext,
  mapOutputsArray,
  parseArtifactList,
  parseGeneratedPieces,
  parseIssueList,
  parseNoteList,
  type GeneratedPiece,
} from "./parse";
import {
  CONTENT_TYPES,
  MAX_CONTENT_TYPES,
  defaultPromptForType,
  type ContentTypeId,
} from "./prompts";

type StepPhase = NonNullable<ReturnType<RunState["steps"]["get"]>>["phase"];

const ALL_STEP_IDS = [
  "list-artifacts",
  "list-notes",
  "list-issues",
  "sources",
  "fetch-artifacts",
  "fetch-notes",
  "fetch-issues",
  "options",
  "generate",
  "review",
  "regenerateGate",
  "regenerate",
  "review-final",
  "persist",
  "persist-after-regen",
] as const;

function phaseFor(state: RunState | null, id: string): StepPhase | undefined {
  return state?.steps.get(id)?.phase;
}

function activeDisplayIndex(state: RunState | null): number {
  return activeDisplayStepIndex(state, DISPLAY_STEPS);
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

function hasFailed(state: RunState | null): boolean {
  if (!state) return false;
  if (state.phase === "failed") return true;
  for (const id of ALL_STEP_IDS) {
    if (phaseFor(state, id) === "failed") return true;
  }
  return false;
}

type DisplayGroup = "sources" | "options" | "review" | "done";

function activeDisplayGroup(state: RunState | null): DisplayGroup {
  return (DISPLAY_STEPS[activeDisplayIndex(state)]?.key ??
    "done") as DisplayGroup;
}

const fieldClass =
  "w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange";

function SectionCard({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-border bg-surface p-4 shadow-sm">
      <h3 className="mb-3 text-[13px] font-semibold text-text">{title}</h3>
      {children}
    </section>
  );
}

function Placeholder({ label }: { label: string }) {
  return <p className="text-[13px] text-text-3">{label}</p>;
}

function ErrorLine({ label }: { label: string }) {
  return <p className="text-[13px] text-orange">{label}</p>;
}

function toggleId(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function SourcesStep({
  stepOutputs,
  sourcesPhase,
  onSignal,
}: {
  stepOutputs: Record<string, unknown>;
  sourcesPhase: StepPhase | undefined;
  onSignal: (name: string, payload: unknown) => void;
}) {
  const awaiting = sourcesPhase === "awaiting-signal";
  const [artifactIds, setArtifactIds] = useState<Set<string>>(new Set());
  const [noteIds, setNoteIds] = useState<Set<string>>(new Set());
  const [issueIds, setIssueIds] = useState<Set<string>>(new Set());
  const [text, setText] = useState("");

  const artifacts = parseArtifactList(stepOutputs["list-artifacts"]);
  const notes = parseNoteList(stepOutputs["list-notes"]);
  const issues = parseIssueList(stepOutputs["list-issues"]);

  const hasSource =
    artifactIds.size > 0 ||
    noteIds.size > 0 ||
    issueIds.size > 0 ||
    text.trim().length > 0;

  const listsReady =
    phaseForListsReady(stepOutputs) ||
    artifacts.status !== "failed" ||
    notes.status !== "failed" ||
    issues.status !== "failed";

  function submit() {
    if (!awaiting || !hasSource) return;
    onSignal("sources", {
      artifactItems: [...artifactIds].map((artifactId) => ({ artifactId })),
      noteItems: [...noteIds].map((noteId) => ({ noteId })),
      issueItems: [...issueIds].map((id) => ({ id })),
      ...(text.trim() ? { text: text.trim() } : {}),
    });
  }

  if (!listsReady && sourcesPhase !== "awaiting-signal") {
    return <Placeholder label="Loading source lists…" />;
  }

  return (
    <div className="space-y-4">
      <SectionCard title="Workbench artifacts">
        {artifacts.status === "failed" ? (
          <ErrorLine label="Could not load artifacts." />
        ) : artifacts.status === "empty" ? (
          <Placeholder label="No artifacts yet." />
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {artifacts.value.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-[8px] px-2 py-1.5 text-[13px] hover:bg-surface-2">
                  <input
                    type="checkbox"
                    disabled={!awaiting}
                    checked={artifactIds.has(a.id)}
                    onChange={() => setArtifactIds((s) => toggleId(s, a.id))}
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-text">
                      {a.title ?? a.id}
                    </span>
                    {a.kind ? (
                      <span className="ml-2 text-[11px] text-text-3">
                        {a.kind}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Granola call notes">
        {notes.status === "failed" ? (
          <ErrorLine label="Could not load call notes." />
        ) : notes.status === "empty" ? (
          <Placeholder label="No call notes." />
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {notes.value.map((n) => (
              <li key={n.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-[8px] px-2 py-1.5 text-[13px] hover:bg-surface-2">
                  <input
                    type="checkbox"
                    disabled={!awaiting}
                    checked={noteIds.has(n.id)}
                    onChange={() => setNoteIds((s) => toggleId(s, n.id))}
                  />
                  <span className="min-w-0 font-medium text-text">
                    {n.title ?? n.id}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Linear issues">
        {issues.status === "failed" ? (
          <ErrorLine label="Linear unavailable or not configured." />
        ) : issues.status === "empty" ? (
          <Placeholder label="No issues returned." />
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto">
            {issues.value.map((issue) => (
              <li key={issue.id}>
                <label className="flex cursor-pointer items-start gap-2 rounded-[8px] px-2 py-1.5 text-[13px] hover:bg-surface-2">
                  <input
                    type="checkbox"
                    disabled={!awaiting}
                    checked={issueIds.has(issue.id)}
                    onChange={() => setIssueIds((s) => toggleId(s, issue.id))}
                  />
                  <span className="min-w-0">
                    <span className="mr-1 text-[11px] text-text-3">
                      {issue.identifier ?? issue.id}
                    </span>
                    <span className="font-medium text-text">
                      {issue.title ?? "Untitled"}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Free text (optional)">
        <textarea
          className={fieldClass}
          rows={4}
          disabled={!awaiting}
          placeholder="Paste notes, brief, or extra context…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </SectionCard>

      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={!awaiting || !hasSource}
          onClick={submit}
        >
          Continue
        </Button>
        {!hasSource ? (
          <span className="text-[12px] text-text-3">
            Pick at least one source.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function phaseForListsReady(stepOutputs: Record<string, unknown>): boolean {
  return (
    stepOutputs["list-artifacts"] !== undefined ||
    stepOutputs["list-notes"] !== undefined ||
    stepOutputs["list-issues"] !== undefined
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function OptionsStep({
  stepOutputs,
  optionsPhase,
  onSignal,
}: {
  stepOutputs: Record<string, unknown>;
  optionsPhase: StepPhase | undefined;
  onSignal: (name: string, payload: unknown) => void;
}) {
  const awaiting = optionsPhase === "awaiting-signal";
  const [selected, setSelected] = useState<Set<ContentTypeId>>(new Set());
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [goal, setGoal] = useState("");
  const [promptOverrides, setPromptOverrides] = useState<
    Partial<Record<ContentTypeId, string>>
  >({});
  const [showPrompt, setShowPrompt] = useState<ContentTypeId | null>(null);

  const sourceContext = useMemo(() => {
    const sources = stepOutputs.sources as
      | { text?: string }
      | undefined;
    return buildSourceContext({
      artifactOutputs: mapOutputsArray(stepOutputs["fetch-artifacts"]),
      noteOutputs: mapOutputsArray(stepOutputs["fetch-notes"]),
      issueOutputs: mapOutputsArray(stepOutputs["fetch-issues"]),
      text: sources?.text,
    });
  }, [stepOutputs]);

  function toggleType(id: ContentTypeId) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      if (next.size >= MAX_CONTENT_TYPES) return prev;
      next.add(id);
      return next;
    });
  }

  function submit() {
    if (!awaiting || selected.size === 0) return;
    if (!sourceContext.trim()) return;
    const items = [...selected].map((contentType) => {
      const override = promptOverrides[contentType]?.trim();
      return {
        contentType,
        format: contentType,
        sourceContext,
        systemPrompt: override ?? defaultPromptForType(contentType),
        ...(audience.trim() ? { audience: audience.trim() } : {}),
        ...(tone.trim() ? { tone: tone.trim() } : {}),
        ...(goal.trim() ? { goal: goal.trim() } : {}),
      };
    });
    onSignal("options", { items });
  }

  if (optionsPhase !== "awaiting-signal" && optionsPhase !== "completed") {
    return <Placeholder label="Loading sources…" />;
  }

  return (
    <div className="space-y-4">
      <SectionCard title="Content types">
        <p className="mb-2 text-[12px] text-text-3">
          Select up to {MAX_CONTENT_TYPES}. Each becomes one draft.
        </p>
        <ul className="space-y-1">
          {CONTENT_TYPES.map((ct) => (
            <li key={ct.id} className="rounded-[8px] border border-border px-2 py-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  disabled={!awaiting}
                  checked={selected.has(ct.id)}
                  onChange={() => toggleType(ct.id)}
                />
                <span className="flex-1 font-medium text-text">{ct.label}</span>
                {selected.has(ct.id) ? (
                  <button
                    type="button"
                    className="text-[11px] text-orange"
                    disabled={!awaiting}
                    onClick={(e) => {
                      e.preventDefault();
                      setShowPrompt((cur) =>
                        cur === ct.id ? null : ct.id,
                      );
                    }}
                  >
                    Customize prompt
                  </button>
                ) : null}
              </label>
              {showPrompt === ct.id && selected.has(ct.id) ? (
                <textarea
                  className={`${fieldClass} mt-2 font-mono text-[11px]`}
                  rows={6}
                  disabled={!awaiting}
                  value={
                    promptOverrides[ct.id] ?? defaultPromptForType(ct.id)
                  }
                  onChange={(e) =>
                    setPromptOverrides((prev) => ({
                      ...prev,
                      [ct.id]: e.target.value,
                    }))
                  }
                />
              ) : null}
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Shared options (optional)">
        <div className="space-y-2">
          <input
            className={fieldClass}
            disabled={!awaiting}
            placeholder="Audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
          />
          <input
            className={fieldClass}
            disabled={!awaiting}
            placeholder="Tone"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
          />
          <input
            className={fieldClass}
            disabled={!awaiting}
            placeholder="Goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
        </div>
      </SectionCard>

      {!sourceContext.trim() ? (
        <ErrorLine label="Source context is empty — go back is not available; re-run if fetches failed." />
      ) : null}

      <Button
        variant="primary"
        size="sm"
        disabled={!awaiting || selected.size === 0 || !sourceContext.trim()}
        onClick={submit}
      >
        Generate {selected.size || ""} draft{selected.size === 1 ? "" : "s"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review (Good / Bad / Regenerate)
// ---------------------------------------------------------------------------

type ReviewDecision = "good" | "bad" | "regen" | null;

function ReviewQueue({
  pieces,
  phase,
  allowRegen,
  priorApproved,
  onSignal,
  signalName,
}: {
  pieces: GeneratedPiece[];
  phase: StepPhase | undefined;
  allowRegen: boolean;
  priorApproved: GeneratedPiece[];
  onSignal: (name: string, payload: unknown) => void;
  signalName: "review" | "review-final";
}) {
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<ReviewDecision[]>(() =>
    pieces.map(() => null),
  );
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const awaiting = phase === "awaiting-signal";
  const active = pieces[index];
  const allDecided =
    pieces.length === 0 || decisions.every((d) => d !== null);

  function decide(d: ReviewDecision) {
    if (!awaiting || active === undefined) return;
    setDecisions((prev) => {
      const next = [...prev];
      next[index] = d;
      return next;
    });
    if (d === "regen") {
      setFeedbackOpen(true);
      return;
    }
    setFeedbackOpen(false);
    if (index < pieces.length - 1) setIndex(index + 1);
  }

  function submit() {
    if (!awaiting || !allDecided) return;
    const approvedPieces: GeneratedPiece[] = [...priorApproved];
    const regenerateItems: Array<{
      contentType: string;
      sourceContext: string;
      systemPrompt: string;
      previousContent: string;
      feedback: string;
    }> = [];

    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const decision = decisions[i];
      if (!piece || decision === null) continue;
      if (decision === "good") {
        approvedPieces.push(piece);
      } else if (decision === "regen" && allowRegen) {
        const fb = feedback[i]?.trim() ?? "";
        if (!fb) return;
        regenerateItems.push({
          contentType: piece.format,
          sourceContext: "", // filled below from step outputs by parent — see submitReview
          systemPrompt: "",
          previousContent: piece.content,
          feedback: fb,
        });
      }
    }

    if (signalName === "review-final") {
      onSignal("review-final", { approvedPieces });
      return;
    }

    // Parent must enrich regenerate items; we pass a marker via custom event shape
    onSignal("review", {
      approvedPieces,
      shouldRegenerate: regenerateItems.length > 0,
      regenerateItems,
      _pieces: pieces,
      _decisions: decisions,
      _feedback: feedback,
    });
  }

  if (pieces.length === 0) {
    return (
      <div className="space-y-3">
        <Placeholder label="No drafts to review." />
        <Button
          variant="primary"
          size="sm"
          disabled={!awaiting}
          onClick={() => {
            if (signalName === "review-final") {
              onSignal("review-final", { approvedPieces: priorApproved });
            } else {
              onSignal("review", {
                approvedPieces: priorApproved,
                shouldRegenerate: false,
                regenerateItems: [],
              });
            }
          }}
        >
          Continue
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-text-3">
        {index + 1} / {pieces.length}
        {allowRegen ? " · Good keeps · Bad discards · Regenerate asks for feedback" : " · Good keeps · Bad discards"}
      </p>

      {active ? (
        <div className="flex min-h-[360px] flex-col rounded-[14px] border border-border bg-surface shadow-sm">
          <div className="border-b border-border px-5 py-4">
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-text-3">
              {active.format}
            </span>
            <h3 className="mt-3 text-[16px] font-semibold text-text">
              {active.title}
            </h3>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <Markdown>{active.content}</Markdown>
          </div>
          {feedbackOpen ? (
            <div className="space-y-2 border-t border-border p-4">
              <textarea
                className={fieldClass}
                rows={3}
                placeholder="What should change?"
                value={feedback[index] ?? ""}
                onChange={(e) =>
                  setFeedback((prev) => ({ ...prev, [index]: e.target.value }))
                }
              />
              <Button
                variant="primary"
                size="sm"
                disabled={!awaiting || !(feedback[index]?.trim())}
                onClick={() => {
                  if (index < pieces.length - 1) {
                    setIndex(index + 1);
                    setFeedbackOpen(false);
                  } else {
                    setFeedbackOpen(false);
                  }
                }}
              >
                Save feedback
              </Button>
            </div>
          ) : (
            <div
              className={`grid gap-3 border-t border-border bg-bg p-4 ${allowRegen ? "grid-cols-3" : "grid-cols-2"}`}
            >
              <button
                type="button"
                disabled={!awaiting}
                onClick={() => decide("bad")}
                className="rounded-[12px] border border-orange/40 bg-orange/10 px-3 py-3 text-[13px] font-semibold text-orange disabled:opacity-60"
              >
                Bad
              </button>
              {allowRegen ? (
                <button
                  type="button"
                  disabled={!awaiting}
                  onClick={() => decide("regen")}
                  className="rounded-[12px] border border-border bg-surface-2 px-3 py-3 text-[13px] font-semibold text-text disabled:opacity-60"
                >
                  Regenerate
                </button>
              ) : null}
              <button
                type="button"
                disabled={!awaiting}
                onClick={() => decide("good")}
                className="rounded-[12px] border border-green/40 bg-green/10 px-3 py-3 text-[13px] font-semibold text-green disabled:opacity-60"
              >
                Good
              </button>
            </div>
          )}
        </div>
      ) : null}

      {allDecided && !feedbackOpen ? (
        <Button
          variant="primary"
          size="sm"
          disabled={!awaiting}
          onClick={submit}
        >
          {allowRegen && decisions.some((d) => d === "regen")
            ? "Regenerate selected & continue"
            : "Save approved"}
        </Button>
      ) : null}
    </div>
  );
}

function ReviewStep({
  stepOutputs,
  reviewPhase,
  onSignal,
}: {
  stepOutputs: Record<string, unknown>;
  reviewPhase: StepPhase | undefined;
  onSignal: (name: string, payload: unknown) => void;
}) {
  const pieces = parseGeneratedPieces(stepOutputs.generate);
  const optionsItems = (
    stepOutputs.options as { items?: Array<Record<string, unknown>> } | undefined
  )?.items;

  function handleSignal(name: string, payload: unknown) {
    if (name !== "review") {
      onSignal(name, payload);
      return;
    }
    const p = payload as {
      approvedPieces: GeneratedPiece[];
      shouldRegenerate: boolean;
      regenerateItems: Array<{
        contentType: string;
        previousContent: string;
        feedback: string;
        sourceContext: string;
        systemPrompt: string;
      }>;
      _pieces?: GeneratedPiece[];
      _decisions?: ReviewDecision[];
      _feedback?: Record<number, string>;
    };

    if (!p.shouldRegenerate) {
      onSignal("review", {
        approvedPieces: p.approvedPieces,
        shouldRegenerate: false,
        regenerateItems: [],
      });
      return;
    }

    const regenerateItems = [];
    const piecesList = p._pieces ?? pieces;
    const decisions = p._decisions ?? [];
    const feedbackMap = p._feedback ?? {};

    for (let i = 0; i < piecesList.length; i++) {
      if (decisions[i] !== "regen") continue;
      const piece = piecesList[i];
      if (!piece) continue;
      const fb = feedbackMap[i]?.trim() ?? "";
      if (!fb) continue;
      const opt = optionsItems?.find(
        (item) =>
          item.contentType === piece.format || item.format === piece.format,
      );
      regenerateItems.push({
        contentType: piece.format,
        sourceContext:
          typeof opt?.sourceContext === "string" ? opt.sourceContext : "",
        systemPrompt:
          typeof opt?.systemPrompt === "string" ? opt.systemPrompt : "",
        previousContent: piece.content,
        feedback: fb,
        ...(typeof opt?.audience === "string"
          ? { audience: opt.audience }
          : {}),
        ...(typeof opt?.tone === "string" ? { tone: opt.tone } : {}),
        ...(typeof opt?.goal === "string" ? { goal: opt.goal } : {}),
      });
    }

    onSignal("review", {
      approvedPieces: p.approvedPieces,
      shouldRegenerate: regenerateItems.length > 0,
      regenerateItems,
    });
  }

  return (
    <ReviewQueue
      pieces={pieces}
      phase={reviewPhase}
      allowRegen
      priorApproved={[]}
      onSignal={handleSignal}
      signalName="review"
    />
  );
}

function ReviewFinalStep({
  stepOutputs,
  reviewFinalPhase,
  onSignal,
}: {
  stepOutputs: Record<string, unknown>;
  reviewFinalPhase: StepPhase | undefined;
  onSignal: (name: string, payload: unknown) => void;
}) {
  const pieces = parseGeneratedPieces(stepOutputs.regenerate);
  const prior =
    (
      stepOutputs.review as
        | { approvedPieces?: GeneratedPiece[] }
        | undefined
    )?.approvedPieces ?? [];

  return (
    <ReviewQueue
      pieces={pieces}
      phase={reviewFinalPhase}
      allowRegen={false}
      priorApproved={prior}
      onSignal={onSignal}
      signalName="review-final"
    />
  );
}

function DoneStep({
  stepOutputs,
  onClose,
}: {
  stepOutputs: Record<string, unknown>;
  onClose: () => void;
}) {
  const fromReview =
    (
      stepOutputs.review as
        | { approvedPieces?: GeneratedPiece[] }
        | undefined
    )?.approvedPieces ?? [];
  const fromFinal =
    (
      stepOutputs["review-final"] as
        | { approvedPieces?: GeneratedPiece[] }
        | undefined
    )?.approvedPieces ?? [];
  const approved = fromFinal.length > 0 ? fromFinal : fromReview;

  return (
    <div className="space-y-4">
      <p className="text-[13px] font-medium text-text">
        {approved.length > 0
          ? `Saved ${approved.length} artifact${approved.length === 1 ? "" : "s"}.`
          : "Run complete — nothing saved."}
      </p>
      {approved.length > 0 ? (
        <ul className="space-y-1.5">
          {approved.map((p) => (
            <li
              key={`${p.format}-${p.title}`}
              className="rounded-[7px] border border-border bg-surface px-3 py-2 text-[13px] text-text"
            >
              <span className="mr-2 rounded-[5px] bg-surface-2 px-2 py-0.5 text-[11px] text-text-3">
                {p.format}
              </span>
              {p.title}
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function Panel(props: WorkflowPanelProps) {
  const { state, connected, stepOutputs, onSignal, onClose } = props;
  const group = activeDisplayGroup(state);
  const failed = hasFailed(state);
  const stepperSteps = buildStepperSteps(state);
  const liveLabel = failed ? null : liveStatusLabel(state, DISPLAY_STEPS);
  const showShellHeader = workflowPanelShowsShellHeader(props);

  // Prefer review-final when that gate is pending
  const reviewFinalPhase = phaseFor(state, "review-final");
  const showReviewFinal =
    reviewFinalPhase === "awaiting-signal" ||
    (group === "review" &&
      phaseFor(state, "regenerate") === "completed" &&
      reviewFinalPhase !== "completed" &&
      reviewFinalPhase !== undefined);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-bg">
      {showShellHeader ? (
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-text">
              Multi-Source Collateral
            </p>
            <p className="mt-px text-[11px] text-text-3">
              {connected ? "Live" : "Reconnecting…"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-[8px] border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="h-4 w-4"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>
      ) : null}

      <div className="shrink-0 border-b border-border bg-surface px-5 py-3">
        <HorizontalStepper steps={stepperSteps} />
        <LiveStatusSlot label={liveLabel} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {failed ? (
          <FailedRunNotice />
        ) : (
          <>
            {group === "sources" ? (
              <SourcesStep
                stepOutputs={stepOutputs}
                sourcesPhase={phaseFor(state, "sources")}
                onSignal={onSignal}
              />
            ) : null}
            {group === "options" ? (
              <OptionsStep
                stepOutputs={stepOutputs}
                optionsPhase={phaseFor(state, "options")}
                onSignal={onSignal}
              />
            ) : null}
            {group === "review" && showReviewFinal ? (
              <ReviewFinalStep
                stepOutputs={stepOutputs}
                reviewFinalPhase={reviewFinalPhase}
                onSignal={onSignal}
              />
            ) : null}
            {group === "review" && !showReviewFinal ? (
              <ReviewStep
                stepOutputs={stepOutputs}
                reviewPhase={phaseFor(state, "review")}
                onSignal={onSignal}
              />
            ) : null}
            {group === "done" ? (
              <DoneStep stepOutputs={stepOutputs} onClose={onClose} />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export { DISPLAY_STEPS } from "./display-steps";

export const label = "Multi-Source Collateral";
export const description =
  "Choose mixed sources, pick content types, generate, swipe review with feedback regenerate.";
export const kind = "multi-source-collateral";
