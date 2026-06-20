import { useState } from "react";
import { type } from "arktype";
import {
  HorizontalStepper,
  type WorkflowPanelProps,
  type WorkflowStep,
} from "@workbench/ui";
import type { RunState } from "@intx/workflow";

const STEPS = [
  { id: "template", label: "Template" },
  { id: "source", label: "Source" },
  { id: "generate", label: "Generate" },
  { id: "review", label: "Review" },
  { id: "render", label: "Render" },
] as const;

type StepPhase = NonNullable<ReturnType<RunState["steps"]["get"]>>["phase"];

const TemplateList = type({
  templates: type({
    gammaId: "string",
    name: "string",
  }).array(),
});

const TemplateOutput = type({
  "gammaId?": "string",
  "templateId?": "string",
  "audience?": "string",
  "tone?": "string",
  "goal?": "string",
});

const NotesList = type({
  notes: type({
    id: "string",
    "title?": "string | null",
  }).array(),
});

const SourceOutput = type({
  "title?": "string | null",
  "summary?": "string",
});

const GenerateOutput = type({
  "title?": "string",
  "outline?": "string",
});

const RenderOutput = type({
  "gammaUrl?": "string",
  "url?": "string",
});

// `render` is a deterministic tool step: its output is the agent-runtime
// `ToolResult` envelope whose `content` is the gamma handler's JSON string.
const ToolResultEnvelope = type({ content: "string" });

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stepPhase(
  state: RunState | null,
  stepId: string,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(
  phase: StepPhase | undefined,
  isCurrent: boolean,
): WorkflowStep["status"] {
  if (phase === "completed") return "completed";
  if (
    phase === "in-flight" ||
    phase === "awaiting-signal" ||
    phase === "awaiting-timer" ||
    isCurrent
  ) {
    return "current";
  }
  return "pending";
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  const firstActiveIndex = STEPS.findIndex((s) => {
    const phase = stepPhase(state, s.id);
    return phase !== "completed";
  });
  return STEPS.map((s, index) => {
    const phase = stepPhase(state, s.id);
    return {
      number: index + 1,
      label: s.label,
      status: toStepperStatus(phase, index === firstActiveIndex),
    };
  });
}

type TemplateOption = { gammaId: string; name: string };

function readTemplateOptions(
  stepOutputs: Record<string, unknown>,
): TemplateOption[] {
  const parsed = TemplateList(stepOutputs["list-templates"]);
  if (parsed instanceof type.errors) return [];
  return parsed.templates.map((t) => ({ gammaId: t.gammaId, name: t.name }));
}

type NoteOption = { id: string; title: string };

function readNoteOptions(stepOutputs: Record<string, unknown>): NoteOption[] {
  const parsed = NotesList(stepOutputs["list-notes"]);
  if (parsed instanceof type.errors) return [];
  return parsed.notes.map((n) => ({
    id: n.id,
    title: readString(n.title) ?? n.id,
  }));
}

function briefRows(
  stepOutputs: Record<string, unknown>,
): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const template = TemplateOutput(stepOutputs.template);
  if (!(template instanceof type.errors)) {
    const templateId =
      readString(template.gammaId) ?? readString(template.templateId);
    if (templateId) rows.push({ label: "Template", value: templateId });
    const audience = readString(template.audience);
    if (audience) rows.push({ label: "Audience", value: audience });
    const tone = readString(template.tone);
    if (tone) rows.push({ label: "Tone", value: tone });
    const goal = readString(template.goal);
    if (goal) rows.push({ label: "Goal", value: goal });
  }
  const source = SourceOutput(stepOutputs.source);
  if (!(source instanceof type.errors)) {
    const callTitle = readString(source.title);
    if (callTitle) rows.push({ label: "Source", value: callTitle });
  }
  return rows;
}

function readGenerate(stepOutputs: Record<string, unknown>): {
  title: string | undefined;
  outline: string | undefined;
  malformed: boolean;
} {
  const parsed = GenerateOutput(stepOutputs.generate);
  if (parsed instanceof type.errors) {
    return { title: undefined, outline: undefined, malformed: true };
  }
  return {
    title: readString(parsed.title),
    outline: readString(parsed.outline),
    malformed: false,
  };
}

function readGammaUrl(
  stepOutputs: Record<string, unknown>,
): string | undefined {
  // Peel the deterministic-tool envelope: parse `content` (a JSON string)
  // into the gamma result, then read its url. Fall back to a bare shape so a
  // hand-fed (non-envelope) output still resolves in tests/dev.
  const envelope = ToolResultEnvelope(stepOutputs.render);
  let candidate: unknown = stepOutputs.render;
  if (!(envelope instanceof type.errors)) {
    try {
      candidate = JSON.parse(envelope.content);
    } catch {
      return undefined;
    }
  }
  const parsed = RenderOutput(candidate);
  if (parsed instanceof type.errors) return undefined;
  return readString(parsed.gammaUrl) ?? readString(parsed.url);
}

function isSafePresentationUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="grid h-[28px] w-[28px] place-items-center rounded-[8px] border border-border text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
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
  );
}

function PresentationFrame({ url }: { url: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-border bg-surface">
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

function TemplateForm({
  templates,
  onSubmit,
}: {
  templates: TemplateOption[];
  onSubmit: (payload: {
    gammaId: string;
    templateId: string;
    audience: string;
    tone: string;
    goal: string;
  }) => void;
}) {
  const [gammaId, setGammaId] = useState(templates[0]?.gammaId ?? "");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");
  const [goal, setGoal] = useState("");
  const canSubmit = gammaId.trim().length > 0 && goal.trim().length > 0;

  const fieldClass =
    "w-full rounded-[8px] border border-border bg-surface px-3 py-2 text-[13px] text-text";

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        onSubmit({
          gammaId: gammaId.trim(),
          templateId: gammaId.trim(),
          audience: audience.trim(),
          tone: tone.trim(),
          goal: goal.trim(),
        });
      }}
    >
      <h3 className="text-[13px] font-semibold text-text">Set up the deck</h3>
      <label className="block space-y-1">
        <span className="text-[12px] text-text-3">Template</span>
        {templates.length > 0 ? (
          <select
            aria-label="Template"
            value={gammaId}
            onChange={(e) => setGammaId(e.target.value)}
            className={fieldClass}
          >
            {templates.map((t) => (
              <option key={t.gammaId} value={t.gammaId}>
                {t.name}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="Template"
            value={gammaId}
            onChange={(e) => setGammaId(e.target.value)}
            placeholder="Template gammaId"
            className={fieldClass}
          />
        )}
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-text-3">Audience</span>
        <input
          aria-label="Audience"
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-text-3">Tone</span>
        <input
          aria-label="Tone"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
          className={fieldClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[12px] text-text-3">Goal</span>
        <input
          aria-label="Goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          className={fieldClass}
        />
      </label>
      <button
        type="submit"
        disabled={!canSubmit}
        className="btn-primary block w-full text-center"
      >
        Continue
      </button>
    </form>
  );
}

function SourceSelect({
  notes,
  onSelect,
}: {
  notes: NoteOption[];
  onSelect: (noteId: string) => void;
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-[13px] font-semibold text-text">Choose a call</h3>
      {notes.length === 0 ? (
        <p className="rounded-[10px] border border-border bg-surface px-4 py-3 text-[12px] text-text-3">
          No Granola calls available.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-[10px] border border-border bg-surface">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                className="block w-full px-3 py-2 text-left text-[13px] text-text transition-colors hover:bg-surface-2"
              >
                {n.title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const RUN_PHASE_LABEL: Record<string, string> = {
  pending: "Setting up",
  running: "Running",
  cancelling: "Cancelling",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function Panel({
  state,
  connected,
  stepOutputs,
  onSignal,
  onClose,
}: WorkflowPanelProps) {
  const stepperSteps = buildStepperSteps(state);
  const rows = briefRows(stepOutputs);
  const generate = readGenerate(stepOutputs);
  const gammaUrl = readGammaUrl(stepOutputs);
  const templatePhase = stepPhase(state, "template");
  const sourceSelectionPhase = stepPhase(state, "source-selection");
  const reviewPhase = stepPhase(state, "review");
  const renderPhase = stepPhase(state, "render");
  const generatePhase = stepPhase(state, "generate");
  const generateMalformed = generate.malformed && generatePhase === "completed";
  const runPhase = state?.phase ?? "pending";
  const statusLabel = RUN_PHASE_LABEL[runPhase] ?? runPhase;
  const awaitingTemplate = templatePhase === "awaiting-signal";
  const awaitingSource = sourceSelectionPhase === "awaiting-signal";
  const awaitingReview = reviewPhase === "awaiting-signal";
  const isDone = renderPhase === "completed" && runPhase === "completed";

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-panel border border-border bg-bg">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold text-text">
            {generate.title ?? "Gamma Presentation"}
          </p>
          <p className="mt-px font-mono text-[11px] text-text-3">
            {statusLabel}
            {connected ? "" : " · disconnected"}
          </p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <HorizontalStepper steps={stepperSteps} />

      <div className="flex flex-1 flex-col space-y-5 overflow-y-auto p-5">
        {awaitingTemplate && (
          <TemplateForm
            templates={readTemplateOptions(stepOutputs)}
            onSubmit={(payload) => onSignal("template", payload)}
          />
        )}

        {awaitingSource && (
          <SourceSelect
            notes={readNoteOptions(stepOutputs)}
            onSelect={(noteId) => onSignal("source-selection", { noteId })}
          />
        )}

        {rows.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text">Brief</h3>
            <dl className="divide-y divide-border rounded-[10px] border border-border bg-surface">
              {rows.map((row) => (
                <div key={row.label} className="flex gap-3 px-3 py-2">
                  <dt className="w-24 shrink-0 text-[12px] text-text-3">
                    {row.label}
                  </dt>
                  <dd className="break-words text-[12px] text-text">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}

        {generateMalformed && (
          <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-orange">
              Couldn’t read the draft outline.
            </p>
            <p className="mt-1 text-[12px] text-text-3">
              The generate step finished but its result was malformed.
            </p>
          </div>
        )}

        {generate.outline && (
          <div className="space-y-2">
            <h3 className="text-[13px] font-semibold text-text">
              Draft outline
            </h3>
            <div className="rounded-[10px] border border-border bg-surface px-4 py-3">
              <p className="whitespace-pre-wrap text-[12px] text-text-2">
                {generate.outline}
              </p>
            </div>
          </div>
        )}

        {awaitingReview && (
          <div className="space-y-1 rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-text">
              Review the draft
            </p>
            <p className="text-[12px] text-text-3">
              Approve the generated content to render the deck in Gamma.
            </p>
          </div>
        )}

        {runPhase === "failed" && (
          <div className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3">
            <p className="text-[13px] font-medium text-text">
              Generation failed
            </p>
            <p className="mt-1 text-[12px] text-text-3">
              The deck could not be generated. Start a new run to try again.
            </p>
          </div>
        )}

        {isDone &&
          gammaUrl &&
          (isSafePresentationUrl(gammaUrl) ? (
            <PresentationFrame url={gammaUrl} />
          ) : (
            <p className="rounded-[10px] border border-orange/40 bg-orange/5 px-4 py-3 text-[12px] text-text-3">
              Presentation URL is invalid or unavailable.
            </p>
          ))}
      </div>

      <div className="shrink-0 space-y-2 border-t border-border bg-surface px-4 py-3">
        {awaitingReview && (
          <button
            type="button"
            onClick={() => onSignal("review-approval", { approved: true })}
            className="btn-primary block w-full text-center"
          >
            Approve
          </button>
        )}
        {isDone && isSafePresentationUrl(gammaUrl) && (
          <a
            href={gammaUrl}
            target="_blank"
            rel="noreferrer"
            className="btn-primary block w-full text-center"
          >
            Open in Gamma
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-[9px] border border-border bg-surface-2 px-3 py-2 text-[13px] font-medium text-text-2 transition-colors hover:text-text active:scale-[0.97]"
        >
          Close
        </button>
      </div>
    </div>
  );
}
