import { type ReactNode, useState, useCallback, useMemo } from "react";
import { type } from "arktype";
import type { RunState, StepState } from "@intx/workflow";
import {
  activeDisplayStep,
  buildRunStepperSteps,
  Button,
  ComparisonView,
  type ComparisonResult,
  type DisplayStep,
  FailedRunNotice,
  HorizontalStepper,
  LiveStatusSlot,
  liveStatusLabel,
  parseComparisonResult,
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
// live step outputs — so the in-flight review looks exactly like the saved
// artifact (one renderer, one shape). Returns null until the pieces are ready.
function previewResult(
  configOutput: unknown,
  executeOutput: unknown,
  compareOutput: unknown,
): ComparisonResult | null {
  return parseComparisonResult(
    composeComparisonResult({
      config: { output: configOutput },
      execute: { output: executeOutput },
      compare: { output: compareOutput },
    }),
  );
}

const CONFIG_SIGNAL = "ab-config";
const REVIEW_SIGNAL = "comparison-review";

const STEP_ORDER = [
  "config",
  "execute",
  "compare",
  "review",
  "persist",
] as const;
type StepKey = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<StepKey, string> = {
  config: "Configure",
  execute: "Execute",
  compare: "Compare",
  review: "Review",
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

// One runtime step per display step; the shared helpers encode the robust
// "passed = completed OR a later step progressed" rule so a gate whose output is
// missing from the synthesized record can't rewind the panel mid-run (CL-2506).
// Machine-work steps carry a verb `activityLabel` for the live line; the config
// and review gates carry none (the panel renders their controls instead).
const STEP_ACTIVITY: Partial<Record<StepKey, string>> = {
  execute: "Running the variants",
  compare: "Comparing variants",
  persist: "Saving to workbench",
};

const DISPLAY_STEPS: DisplayStep[] = STEP_ORDER.map((id) => ({
  key: id,
  label: STEP_LABELS[id],
  stepIds: [id],
  ...(STEP_ACTIVITY[id] !== undefined
    ? { activityLabel: STEP_ACTIVITY[id] }
    : {}),
}));

function buildStepperSteps(state: RunState | null): WorkflowStep[] {
  return buildRunStepperSteps(state, DISPLAY_STEPS);
}

function activeStep(state: RunState | null): StepKey {
  return activeDisplayStep(state, DISPLAY_STEPS)?.key as StepKey;
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

// ── Config wizard state ───────────────────────────────────────────────────────

// The config gate is a simple Back/Next flow across these sub-steps. The outer
// workflow stepper already shows "Configure" as the current phase, so there is
// no inner stepper here — that nesting was redundant.
type ConfigStep = "comparisons" | "configure" | "input";

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
  return (
    <LoadingState label="Variants finished — preparing the blind ranking…" />
  );
}

function CompareScreen({
  phase,
  configOutput,
  executeOutput,
  compareOutput,
}: {
  phase: StepPhase | undefined;
  configOutput: unknown;
  executeOutput: unknown;
  compareOutput: unknown;
}) {
  if (phase === "in-flight" || phase === undefined) {
    return <LoadingState label="Generating blind ranking…" />;
  }

  const result = previewResult(configOutput, executeOutput, compareOutput);
  if (result === null) {
    if (phase === "completed") {
      return (
        <Card>
          <p className="text-sm text-orange">
            Couldn't read the comparison output.
          </p>
        </Card>
      );
    }
    return <LoadingState label="Generating blind ranking…" />;
  }

  return (
    <Card>
      <CardTitle>Blind ranking</CardTitle>
      <ComparisonView result={result} blind />
    </Card>
  );
}

function ReviewScreen({
  phase,
  configOutput,
  compareOutput,
  executeOutput,
  connected,
  signalPending,
  onApprove,
  onSkip,
}: {
  phase: StepPhase | undefined;
  configOutput: unknown;
  compareOutput: unknown;
  executeOutput: unknown;
  connected: boolean;
  signalPending: boolean;
  onApprove: () => void;
  onSkip: () => void;
}) {
  if (phase !== "awaiting-signal" && phase !== "in-flight") {
    return <LoadingState label="Waiting for comparison to finish…" />;
  }

  const result = previewResult(configOutput, executeOutput, compareOutput);

  return (
    <div className="space-y-4">
      {result !== null && (
        <Card>
          <CardTitle>Blind ranking</CardTitle>
          <ComparisonView result={result} blind />
        </Card>
      )}

      <Card>
        <CardTitle>Review and approve</CardTitle>
        <p className="mb-4 text-sm text-text-2">
          Review the blind ranking above. Approve to save the results as an
          artifact, or skip to discard.
        </p>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            disabled={
              !connected || signalPending || phase !== "awaiting-signal"
            }
            onClick={onApprove}
          >
            Approve comparison
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              !connected || signalPending || phase !== "awaiting-signal"
            }
            onClick={onSkip}
          >
            Skip
          </Button>
          {!connected && (
            <p className="text-xs text-text-3">
              Reconnecting — approval unavailable.
            </p>
          )}
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
  compareOutput,
  onClose,
}: {
  phase: StepPhase | undefined;
  output: unknown;
  configOutput: unknown;
  executeOutput: unknown;
  compareOutput: unknown;
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
  // saved view is the same ComparisonView the reviewer just approved.
  const result = previewResult(configOutput, executeOutput, compareOutput);

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
  const liveLabel = liveStatusLabel(state, DISPLAY_STEPS);

  function handleConfigSubmit(payload: {
    variants: VariantConfig[];
    input: string;
  }) {
    onSignal(CONFIG_SIGNAL, payload);
  }

  function handleApprove() {
    onSignal(REVIEW_SIGNAL, { approved: true });
  }

  function handleSkip() {
    onSignal(REVIEW_SIGNAL, { approved: false });
  }

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h2 className="text-base font-medium text-text">
            A/B Test - Agent Select
          </h2>
          <p className="text-xs text-text-3">
            Blind ranking across provider/model variants
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

      <div className="flex-1 overflow-y-auto p-6">
        {failed ? (
          <FailedRunNotice state={state} steps={DISPLAY_STEPS} />
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
        ) : current === "compare" ? (
          <CompareScreen
            phase={phaseFor(state, "compare")}
            configOutput={stepOutputs["config"]}
            executeOutput={stepOutputs["execute"]}
            compareOutput={stepOutputs["compare"]}
          />
        ) : current === "review" ? (
          <ReviewScreen
            phase={phaseFor(state, "review")}
            configOutput={stepOutputs["config"]}
            compareOutput={stepOutputs["compare"]}
            executeOutput={stepOutputs["execute"]}
            connected={connected}
            signalPending={signalPending}
            onApprove={handleApprove}
            onSkip={handleSkip}
          />
        ) : (
          <PersistScreen
            phase={phaseFor(state, "persist")}
            output={stepOutputs["persist"]}
            configOutput={stepOutputs["config"]}
            executeOutput={stepOutputs["execute"]}
            compareOutput={stepOutputs["compare"]}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
