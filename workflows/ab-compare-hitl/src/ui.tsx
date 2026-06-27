import { type ReactNode, useState, useCallback, useMemo } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  Button,
  ComparisonView,
  HorizontalStepper,
  parseComparisonResult,
  type ComparisonResult,
  type WorkflowCredential,
  type WorkflowPanelProps,
  type WorkflowSkill,
  type WorkflowStep,
} from "@workbench/ui";
import { composeComparisonResult } from "@workbench/tools-ab-compare";
import {
  defaultAbComparisonModel,
  isAbComparisonModelAllowed,
  listAbComparisonModels,
} from "./models";

// Build the same structured ComparisonResult the persist step saves, from the
// live step outputs (config + execute + the human decision) — so the saved
// artifact looks exactly like what the reviewer just produced. Returns null
// until the pieces are ready.
function previewResult(
  configOutput: unknown,
  executeOutput: unknown,
  decisionOutput: unknown,
): ComparisonResult | null {
  return parseComparisonResult(
    composeComparisonResult({
      config: { output: configOutput },
      execute: { output: executeOutput },
      decision: { output: decisionOutput },
    }),
  );
}

const CONFIG_SIGNAL = "ab-config";
const DECISION_SIGNAL = "ab-decision";

const STEP_ORDER = ["config", "execute", "decision", "persist"] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  config: "Configure",
  execute: "Execute",
  decision: "Decide",
  persist: "Persist",
};

// The payload sent on the ab-config signal.
interface VariantConfig {
  label: string;
  providerName: string;
  model: string;
  systemPrompt?: string;
  skillIds?: string[];
  input: string;
}

// `deterministicToolStep` output: { callId: string, content: "<JSON string>" }.
const ToolResultEnvelope = type({ callId: "string", content: "string" });

const PersistContent = type({
  "artifactId?": "string",
  "title?": "string",
  "kind?": "string",
  "version?": "number",
});

type StepPhase = StepState["phase"];

function phaseFor(
  state: RunState | null,
  stepId: StepKey,
): StepPhase | undefined {
  return state?.steps.get(stepId)?.phase;
}

function toStepperStatus(phase: StepPhase | undefined): WorkflowStep["status"] {
  if (phase === "completed") return "completed";
  if (
    phase === "in-flight" ||
    phase === "awaiting-signal" ||
    phase === "awaiting-timer"
  ) {
    return "current";
  }
  return "pending";
}

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return STEP_ORDER.map((stepId, index) => ({
    number: index + 1,
    label: STEP_LABELS[stepId],
    status: toStepperStatus(phaseFor(state, stepId)),
  }));
}

function activeStep(state: RunState | null): StepKey {
  for (const id of STEP_ORDER) {
    if (phaseFor(state, id) !== "completed") return id;
  }
  return "persist";
}

// ── Shared layout ────────────────────────────────────────────────────────────

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-panel border border-border bg-surface p-6">
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
      <p className="text-sm text-text-3">{label}</p>
    </Card>
  );
}

// ── Config wizard step bar ────────────────────────────────────────────────────

type ConfigStep = "comparisons" | "configure" | "input";

const CONFIG_STEP_LABELS: Record<ConfigStep, string> = {
  comparisons: "Comparisons",
  configure: "Configure",
  input: "Input",
};

function ConfigStepBar({ currentStep }: { currentStep: ConfigStep }) {
  const steps: ConfigStep[] = ["comparisons", "configure", "input"];
  const index = steps.indexOf(currentStep);
  return (
    <div className="flex items-center gap-2 pb-4 shrink-0">
      {steps.map((step, i) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={`grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold ${
              i < index
                ? "bg-green text-white"
                : i === index
                  ? "bg-orange text-white"
                  : "bg-surface-2 text-text-3"
            }`}
          >
            {i < index ? "✓" : i + 1}
          </div>
          <span
            className={`text-[12px] font-medium ${i === index ? "text-text" : "text-text-3"}`}
          >
            {CONFIG_STEP_LABELS[step]}
          </span>
          {i < steps.length - 1 && <span className="mx-1 text-text-3">›</span>}
        </div>
      ))}
    </div>
  );
}

// ── Config wizard state ───────────────────────────────────────────────────────

const PROVIDER_WHITELIST = new Set([
  "openai-compatible",
  "openai",
  "anthropic",
  "google-genai",
]);

interface SlotState {
  credentialId: string;
  providerName: string;
  providerPlugin: string;
  model: string;
  skillIds: string[];
}

function emptySlot(): SlotState {
  return {
    credentialId: "",
    providerName: "",
    providerPlugin: "",
    model: "",
    skillIds: [],
  };
}

// ── Config screen ─────────────────────────────────────────────────────────────

function ConfigScreen({
  phase,
  connected,
  signalPending,
  credentials,
  skills,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  connected: boolean;
  signalPending: boolean;
  credentials: WorkflowCredential[] | undefined;
  skills: WorkflowSkill[] | undefined;
  onSubmit: (payload: { variants: VariantConfig[]; input: string }) => void;
}) {
  const [configStep, setConfigStep] = useState<ConfigStep>("comparisons");
  const [slots, setSlots] = useState<SlotState[]>([emptySlot(), emptySlot()]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [textInput, setTextInput] = useState("");
  const [error, setError] = useState("");

  const whitelisted = useMemo(
    () =>
      (credentials ?? []).filter((c) =>
        PROVIDER_WHITELIST.has(c.providerPlugin),
      ),
    [credentials],
  );

  const updateSlotCredential = useCallback(
    (index: number, credentialId: string) => {
      setSlots((prev) => {
        const next = [...prev];
        const cred = whitelisted.find((c) => c.id === credentialId);
        const providerName = cred?.providerName ?? "";
        const providerPlugin = cred?.providerPlugin ?? "";
        next[index] = {
          credentialId: cred?.id ?? "",
          providerName,
          providerPlugin,
          model: defaultAbComparisonModel(providerName, providerPlugin) ?? "",
          skillIds: next[index]!.skillIds,
        };
        return next;
      });
    },
    [whitelisted],
  );

  const updateSlotModel = useCallback((index: number, model: string) => {
    setSlots((prev) => {
      const next = [...prev];
      next[index] = { ...next[index]!, model };
      return next;
    });
  }, []);

  const toggleSlotSkill = useCallback((index: number, skillId: string) => {
    setSlots((prev) => {
      const next = [...prev];
      const current = next[index]!.skillIds;
      next[index] = {
        ...next[index]!,
        skillIds: current.includes(skillId)
          ? current.filter((id) => id !== skillId)
          : [...current, skillId],
      };
      return next;
    });
  }, []);

  const addSlot = () => {
    setSlots((prev) => [...prev, emptySlot()]);
  };

  const removeSlot = (index: number) => {
    setSlots((prev) => prev.filter((_, i) => i !== index));
  };

  const handleNext = () => {
    setError("");
    if (configStep === "comparisons") {
      const filled = slots.filter((s) => s.credentialId);
      if (filled.length < 2) {
        setError("Select at least two providers to compare.");
        return;
      }
      for (const s of filled) {
        if (!s.model) {
          setError("Select a model for each comparison.");
          return;
        }
        if (
          !isAbComparisonModelAllowed(s.providerName, s.providerPlugin, s.model)
        ) {
          setError(`Model ${s.model} is not available for ${s.providerName}.`);
          return;
        }
      }
      setConfigStep("configure");
    } else if (configStep === "configure") {
      setConfigStep("input");
    } else if (configStep === "input") {
      if (!textInput.trim()) {
        setError("Enter some text to run.");
        return;
      }
      const sharedInput = textInput.trim();
      const variants: VariantConfig[] = slots
        .filter((s) => s.credentialId)
        .map((s, i) => ({
          label: `Variant ${i + 1}`,
          providerName: s.providerName,
          model: s.model,
          input: sharedInput,
          ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
          ...(s.skillIds.length > 0 ? { skillIds: s.skillIds } : {}),
        }));
      onSubmit({ variants, input: sharedInput });
    }
  };

  const handleBack = () => {
    setError("");
    if (configStep === "configure") setConfigStep("comparisons");
    else if (configStep === "input") setConfigStep("configure");
  };

  if (phase !== "awaiting-signal") {
    return <LoadingState label="Waiting for the run to start…" />;
  }

  return (
    <div className="flex flex-col h-full">
      <Card>
        <ConfigStepBar currentStep={configStep} />

        {configStep === "comparisons" && (
          <div className="space-y-4">
            <p className="text-[13px] text-text-2">
              Choose how many comparisons you want and pick a provider for each
              slot.
            </p>
            {credentials === undefined && (
              <p className="text-[13px] text-text-3">Loading credentials…</p>
            )}
            <div className="space-y-3">
              {slots.map((slot, index) => (
                <div
                  key={index}
                  className="rounded-[10px] border border-border p-4 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] font-medium text-text">
                      Comparison {index + 1}
                    </span>
                    {slots.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeSlot(index)}
                        className="text-[11px] text-text-3 hover:text-orange transition-colors"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <select
                    value={slot.credentialId}
                    onChange={(e) =>
                      updateSlotCredential(index, e.target.value)
                    }
                    className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                  >
                    <option value="">Select a provider…</option>
                    {whitelisted.map((cred) => (
                      <option key={cred.id} value={cred.id}>
                        {cred.name} ({cred.providerName} · {cred.providerPlugin}
                        )
                      </option>
                    ))}
                  </select>
                  {slot.credentialId && (
                    <div className="space-y-1">
                      <label className="block text-[12px] font-medium text-text">
                        Model
                      </label>
                      <select
                        value={slot.model}
                        onChange={(e) => updateSlotModel(index, e.target.value)}
                        className="w-full rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text focus:outline-none focus:ring-1 focus:ring-orange/40"
                      >
                        {listAbComparisonModels(
                          slot.providerName,
                          slot.providerPlugin,
                        ).map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-text-3">
                        {slot.providerName} · {slot.providerPlugin}
                      </p>
                    </div>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={addSlot}
                className="w-full rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text"
              >
                Add comparison
              </button>
            </div>
            {whitelisted.length === 0 && credentials !== undefined && (
              <p className="text-[13px] text-text-3">
                No inference credentials available. Add an OpenAI-compatible,
                OpenAI, Anthropic, or Google credential first.
              </p>
            )}
          </div>
        )}

        {configStep === "configure" && (
          <div className="space-y-5">
            <div>
              <label className="block text-[13px] font-medium text-text mb-2">
                Shared system prompt (optional)
              </label>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="Optional instructions applied to every provider…"
                rows={4}
                className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-text mb-2">
                Skill per comparison (optional)
              </label>
              <div className="space-y-3">
                {slots.map((slot, realIndex) => {
                  if (!slot.credentialId) return null;
                  const displayIndex = slots
                    .slice(0, realIndex)
                    .filter((s) => s.credentialId).length;
                  return (
                    <div
                      key={realIndex}
                      className="rounded-[10px] border border-border p-3"
                    >
                      <p className="text-[13px] font-medium text-text mb-2">
                        {slot.providerName
                          ? `Comparison ${displayIndex + 1}: ${slot.providerName}`
                          : `Comparison ${displayIndex + 1}`}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(skills ?? []).map((skill) => {
                          const active = slot.skillIds.includes(skill.id);
                          return (
                            <button
                              key={skill.id}
                              type="button"
                              onClick={() =>
                                toggleSlotSkill(realIndex, skill.id)
                              }
                              className={`rounded-[7px] border px-2.5 py-1 text-[12px] font-medium transition-colors ${
                                active
                                  ? "border-orange bg-orange/8 text-text"
                                  : "border-border text-text-2 hover:text-text"
                              }`}
                            >
                              {skill.displayName ?? skill.name}
                            </button>
                          );
                        })}
                      </div>
                      {skills === undefined && (
                        <p className="text-[12px] text-text-3">
                          Loading skills…
                        </p>
                      )}
                      {skills !== undefined && skills.length === 0 && (
                        <p className="text-[12px] text-text-3">
                          No skills in the library yet.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {configStep === "input" && (
          <div className="space-y-3">
            <p className="text-[13px] text-text-2">
              Enter the shared prompt to run across all providers.
            </p>
            <textarea
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Paste the prompt you want to run across all providers…"
              rows={10}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40"
            />
          </div>
        )}

        {error && <p className="mt-3 text-[12px] text-orange">{error}</p>}

        <div className="mt-4 flex items-center justify-between gap-3">
          <button
            type="button"
            disabled={configStep === "comparisons" || signalPending}
            onClick={handleBack}
            className="rounded-[9px] border border-border bg-surface px-4 py-2 text-[13px] font-medium text-text-2 transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-50"
          >
            Back
          </button>
          <button
            type="button"
            disabled={!connected || signalPending}
            onClick={handleNext}
            className="rounded-[9px] bg-orange px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {signalPending
              ? "Starting…"
              : configStep === "input"
                ? "Run comparison"
                : "Next"}
          </button>
        </div>
        {!connected && (
          <p className="mt-2 text-xs text-text-3">
            Reconnecting — input unavailable.
          </p>
        )}
      </Card>
    </div>
  );
}

function ExecuteScreen({ phase }: { phase: StepPhase | undefined }) {
  if (phase !== "completed") {
    return <LoadingState label="Running the prompt across variants…" />;
  }
  return <LoadingState label="Variants finished — preparing your review…" />;
}

// The human's pick, sent on the ab-decision signal. The compose tool reads it
// as the (human) decision.
interface DecisionPayload {
  ranking: { rank: number; label: string; rationale?: string }[];
  summary?: string;
  recommendation?: string;
}

// Turn the picked winner into a full ranking: winner first (with the reviewer's
// rationale), the rest after in their original order.
function buildRanking(
  labels: readonly string[],
  winner: string,
  rationale: string,
): DecisionPayload["ranking"] {
  const others = labels.filter((label) => label !== winner);
  const rationaleText = rationale.trim();
  const winnerEntry: DecisionPayload["ranking"][number] = {
    rank: 1,
    label: winner,
    ...(rationaleText.length > 0 ? { rationale: rationaleText } : {}),
  };
  return [
    winnerEntry,
    ...others.map((label, index) => ({ rank: index + 2, label })),
  ];
}

function DecisionScreen({
  phase,
  configOutput,
  executeOutput,
  connected,
  signalPending,
  onSubmit,
}: {
  phase: StepPhase | undefined;
  configOutput: unknown;
  executeOutput: unknown;
  connected: boolean;
  signalPending: boolean;
  onSubmit: (payload: DecisionPayload) => void;
}) {
  // The variant outputs to judge, blind (no provider/model). previewResult with
  // no decision yields an empty ranking and the variant content side by side.
  const result = previewResult(configOutput, executeOutput, undefined);
  const labels = (result?.variants ?? []).map((variant) => variant.label);

  const [winner, setWinner] = useState("");
  const [rationale, setRationale] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState("");

  if (phase !== "awaiting-signal" && phase !== "in-flight") {
    return <LoadingState label="Waiting for the variants to finish…" />;
  }
  if (result === null || labels.length === 0) {
    return <LoadingState label="Preparing the variant outputs…" />;
  }

  const locked = !connected || signalPending || phase !== "awaiting-signal";

  function handleSubmit() {
    if (winner === "") {
      setError("Pick a winning variant.");
      return;
    }
    setError("");
    const summaryText = summary.trim();
    onSubmit({
      ranking: buildRanking(labels, winner, rationale),
      ...(summaryText.length > 0 ? { summary: summaryText } : {}),
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardTitle>Variant outputs</CardTitle>
        <p className="mb-4 text-xs text-text-3">
          Outputs are shown anonymously. Provider and model stay hidden until
          you pick a winner.
        </p>
        <ComparisonView result={result} blind />
      </Card>

      <Card>
        <CardTitle>Pick the winner</CardTitle>
        <div className="space-y-3">
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="Winning variant"
          >
            {labels.map((label) => {
              const active = winner === label;
              return (
                <button
                  key={label}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={locked}
                  onClick={() => setWinner(label)}
                  className={`rounded-[9px] border px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${
                    active
                      ? "border-orange bg-orange/8 text-text"
                      : "border-border text-text-2 hover:text-text"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text">
              Why did it win? (optional)
            </label>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="What made the winning variant better…"
              rows={3}
              disabled={locked}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40 disabled:opacity-50"
            />
          </div>
          <div>
            <label className="mb-1 block text-[12px] font-medium text-text">
              Overall note (optional)
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="A one-line takeaway from the comparison…"
              rows={2}
              disabled={locked}
              className="w-full resize-none rounded-[9px] border border-border bg-surface px-3 py-2 text-[13px] text-text placeholder:text-text-3 focus:outline-none focus:ring-1 focus:ring-orange/40 disabled:opacity-50"
            />
          </div>
          {error && <p className="text-[12px] text-orange">{error}</p>}
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              size="sm"
              disabled={locked}
              onClick={handleSubmit}
            >
              Save decision
            </Button>
            {!connected && (
              <p className="text-xs text-text-3">
                Reconnecting — decision unavailable.
              </p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function PersistScreen({
  phase,
  output,
  configOutput,
  executeOutput,
  decisionOutput,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  configOutput: unknown;
  executeOutput: unknown;
  decisionOutput: unknown;
  onClose: () => void;
}) {
  if (phase === "in-flight" || phase === undefined) {
    return <LoadingState label="Saving artifact…" />;
  }

  const envelope = ToolResultEnvelope(output);
  if (envelope instanceof type.errors) {
    if (phase === "completed") {
      return (
        <Card>
          <p className="text-sm text-orange">
            Couldn't read the saved artifact.
          </p>
        </Card>
      );
    }
    return <LoadingState label="Saving artifact…" />;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(envelope.content);
  } catch {
    decoded = undefined;
  }

  const artifact = decoded !== undefined ? PersistContent(decoded) : undefined;
  const saved =
    artifact !== undefined && !(artifact instanceof type.errors)
      ? artifact
      : undefined;

  // The provider/model reveal lives in the variant cards of the result, so the
  // saved view is the same ComparisonView the reviewer just produced.
  const result = previewResult(configOutput, executeOutput, decisionOutput);

  return (
    <div className="space-y-4">
      {result !== null && (
        <Card>
          <CardTitle>Comparison</CardTitle>
          <ComparisonView result={result} />
        </Card>
      )}
      <Card>
        <CardTitle>Comparison saved</CardTitle>
        {saved !== undefined ? (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-3">
            <span className="min-w-0 truncate text-sm text-text">
              {saved.title ?? saved.artifactId ?? "Saved artifact"}
            </span>
            {saved.kind !== undefined && (
              <span className="text-xs text-text-3">{saved.kind}</span>
            )}
          </div>
        ) : (
          <p className="mb-4 text-sm text-text-3">Artifact saved.</p>
        )}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </Card>
    </div>
  );
}

// ── Root panel ────────────────────────────────────────────────────────────────

export function Panel(props: WorkflowPanelProps) {
  const {
    state,
    connected,
    signalPending,
    stepOutputs,
    onSignal,
    onClose,
    credentials,
    skills,
  } = props;
  const failed = state?.phase === "failed";
  const current = activeStep(state);

  function handleConfigSubmit(payload: {
    variants: VariantConfig[];
    input: string;
  }) {
    onSignal(CONFIG_SIGNAL, payload);
  }

  function handleDecisionSubmit(payload: DecisionPayload) {
    onSignal(DECISION_SIGNAL, payload);
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">A/B Test (HITL)</h2>
          <p className="text-xs text-text-3">Blind variants, ranked by you</p>
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

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <div className="rounded-panel border border-orange bg-orange-soft p-4">
            <p className="text-sm text-orange-deep">
              This run failed. Review the run log and try again.
            </p>
          </div>
        ) : current === "config" ? (
          <ConfigScreen
            phase={phaseFor(state, "config")}
            connected={connected}
            signalPending={signalPending}
            credentials={credentials}
            skills={skills}
            onSubmit={handleConfigSubmit}
          />
        ) : current === "execute" ? (
          <ExecuteScreen phase={phaseFor(state, "execute")} />
        ) : current === "decision" ? (
          <DecisionScreen
            phase={phaseFor(state, "decision")}
            configOutput={stepOutputs["config"]}
            executeOutput={stepOutputs["execute"]}
            connected={connected}
            signalPending={signalPending}
            onSubmit={handleDecisionSubmit}
          />
        ) : (
          <PersistScreen
            phase={phaseFor(state, "persist")}
            output={stepOutputs["persist"]}
            configOutput={stepOutputs["config"]}
            executeOutput={stepOutputs["execute"]}
            decisionOutput={stepOutputs["decision"]}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
