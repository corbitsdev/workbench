import type { Selector } from '@intx/workflow';
import { evaluateSelector, type SelectorContext } from '@intx/workflow/runtime';
import type { ArgMap } from '@workbench/agents';
import type { ProjectedStep, ProjectedWorkflow } from './projection';

// The mutable run state the executor reads and writes. Mirrors the
// `workflow_run_record` row: outputs is a stepId -> output map, the gate parks
// on `currentStepId`. Kept as a plain shape so the executor is testable with an
// in-memory record.
export interface RunState {
  runId: string;
  kind: string;
  tenantId: string;
  principalId: string;
  status: 'running' | 'awaiting' | 'completed' | 'failed';
  currentStepId: string | null;
  input: unknown;
  outputs: Record<string, unknown>;
  error?: string;
}

// Persists the run state after every step transition so a restart mid-run
// resumes from the durable record, not in-memory state.
export interface RunStore {
  save(state: RunState): Promise<void>;
}

// Runs a deterministic tool step. The hub implementation resolves the tenant
// credential (or hub context) and invokes the tool directly — no sidecar.
export interface ToolRunner {
  run(args: { tool: string; input: unknown; state: RunState }): Promise<unknown>;
}

// Runs a reasoning step via single-turn `@intx/agent` inference.
export interface ReasoningRunner {
  run(args: {
    stepId: string;
    systemPrompt: string;
    source: { provider: string; model: string };
    credentialName?: string;
    input: unknown;
    state: RunState;
  }): Promise<unknown>;
}

export interface ExecutorDeps {
  store: RunStore;
  toolRunner: ToolRunner;
  reasoningRunner: ReasoningRunner;
}

function buildSelectorContext(state: RunState, triggerPayload?: unknown): SelectorContext {
  const steps: Record<string, { output: unknown }> = {};
  for (const [stepId, output] of Object.entries(state.outputs)) {
    steps[stepId] = { output };
  }
  return {
    trigger: { payload: triggerPayload ?? state.input },
    steps,
  };
}

function resolveInput(
  selector: Selector | undefined,
  state: RunState,
  triggerPayload?: unknown
): unknown {
  if (selector === undefined) return {};
  return evaluateSelector(selector, buildSelectorContext(state, triggerPayload));
}

// Reshape an evaluated step input into the tool's argument object using the
// argMap (the workbench `deterministicToolStep` contract): each key maps to a
// top-level field on the input (`{from}`) or a constant (`{literal}`). With no
// argMap the evaluated input is passed verbatim.
function applyArgMap(input: unknown, argMap: ArgMap | undefined): unknown {
  if (argMap === undefined) return input;
  const source = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const args: Record<string, unknown> = {};
  for (const [argName, spec] of Object.entries(argMap)) {
    if ('literal' in spec) {
      args[argName] = spec.literal;
    } else {
      args[argName] = source[spec.from];
    }
  }
  return args;
}

async function runLeafStep(
  step: ProjectedStep & { kind: 'tool' | 'reasoning' },
  deps: ExecutorDeps,
  state: RunState,
  triggerPayload?: unknown
): Promise<unknown> {
  const input = resolveInput(step.input, state, triggerPayload);
  if (step.kind === 'tool') {
    const args = applyArgMap(input, step.argMap);
    return deps.toolRunner.run({ tool: step.tool, input: args, state });
  }
  return deps.reasoningRunner.run({
    stepId: step.id,
    systemPrompt: step.systemPrompt,
    source: step.source,
    ...(step.credentialName !== undefined ? { credentialName: step.credentialName } : {}),
    input,
    state,
  });
}

async function runStep(step: ProjectedStep, deps: ExecutorDeps, state: RunState): Promise<unknown> {
  if (step.kind === 'map') {
    const over = resolveInput(step.over, state);
    if (!Array.isArray(over)) {
      throw new Error(`map step "${step.id}" over-selector did not resolve to an array`);
    }
    // Fan-out: run each item concurrently (the old fast path used
    // Promise.allSettled; here a failed item fails the run, surfaced loudly).
    return Promise.all(over.map((item) => runLeafStep(step.child, deps, state, item)));
  }
  if (step.kind === 'gate') {
    throw new Error(`runStep called on gate step "${step.id}" — gates are parked, not run`);
  }
  return runLeafStep(step, deps, state, undefined);
}

// Advance the run from its current position: walk `order`, run each
// non-gate step (saving its output and persisting), and STOP at the first
// gate whose output has not yet been supplied — parking the run at
// `status: 'awaiting'` on that step. When all steps are done, mark
// `completed`. State is persisted after every transition, so a crash resumes
// from the record.
export async function advanceRun(
  workflow: ProjectedWorkflow,
  deps: ExecutorDeps,
  state: RunState
): Promise<RunState> {
  try {
    for (const stepId of workflow.order) {
      if (stepId in state.outputs) continue; // already done (incl. resumed gate)
      const step = workflow.steps[stepId];
      if (!step) throw new Error(`step "${stepId}" missing from projection`);

      if (step.kind === 'gate') {
        // Park: the human must supply this step's output via resume.
        state.status = 'awaiting';
        state.currentStepId = stepId;
        await deps.store.save(state);
        return state;
      }

      state.status = 'running';
      state.currentStepId = stepId;
      const output = await runStep(step, deps, state);
      state.outputs[stepId] = output;
      await deps.store.save(state);
    }

    state.status = 'completed';
    state.currentStepId = null;
    await deps.store.save(state);
    return state;
  } catch (cause) {
    state.status = 'failed';
    state.error = cause instanceof Error ? cause.message : String(cause);
    await deps.store.save(state);
    return state;
  }
}

// Apply a gate's submitted payload as that step's output, then continue. The
// run must be awaiting that exact step. Idempotent guards live in the route.
export async function resumeRun(
  workflow: ProjectedWorkflow,
  deps: ExecutorDeps,
  state: RunState,
  signalName: string,
  payload: unknown
): Promise<RunState> {
  if (state.status !== 'awaiting' || state.currentStepId === null) {
    throw new Error(`run "${state.runId}" is not awaiting a signal (status: ${state.status})`);
  }
  const step = workflow.steps[state.currentStepId];
  if (!step || step.kind !== 'gate') {
    throw new Error(`run "${state.runId}" current step is not a gate`);
  }
  if (step.signalName !== signalName) {
    throw new Error(`run "${state.runId}" awaits signal "${step.signalName}", got "${signalName}"`);
  }
  state.outputs[step.id] = payload;
  return advanceRun(workflow, deps, state);
}
