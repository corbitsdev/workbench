import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { buildRerankSystemPrompt, buildWriterSystemPrompt } from "./prompts";

export const label = "last30days Research";
export const description =
  "Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.";
export const kind = "last30days-research";

const sourceSearchInput = { from: "steps.intake.output" } as const;
const sourceQueryArgMap = { query: { from: "query" } } as const;

// A source fetch is best-effort: a dead search API (rate-limit/auth/network)
// must degrade to a recorded skip in the brief, never fail the run. `nonFatal`
// makes the sidecar log the reason and return an isError envelope rather than
// throwing, so the source step completes and `brief` still runs (CL-2401).
// Tradeoff: a degraded step is "completed", so the runtime's tool-step retry
// no longer fires — a transient blip degrades on first failure instead of
// being retried. Acceptable here: not killing the run dominates, and the
// chronic failures (e.g. bluesky) are permanent, not transient.
function sourceStep(opts: {
  id: string;
  tool: string;
  after: readonly string[];
}) {
  return deterministicToolStep({
    id: opts.id,
    tool: opts.tool,
    input: sourceSearchInput,
    argMap: sourceQueryArgMap,
    after: opts.after,
    nonFatal: true,
  });
}

// The source fetches are chained sequentially rather than fanned out in
// parallel. In the sidecar workflow-host topology the runtime body's
// per-runId commit-chain only serializes body-vs-body event commits; the
// scheduler's `TimerFired` (emitted on a tool-step retry) is a second,
// uncoordinated writer to the same run's event log. With a parallel fan-out over
// rate-limit-prone search APIs, a retry timer lands between a concurrent step's
// seq read and its append, tripping the runtime's single-writer seq guard and
// failing the whole run. A serial chain guarantees no body commit is in flight
// while a step awaits its retry timer, so the scheduler write can never race a
// body write. The data flow is unchanged (`brief` still reads every source via
// `{ from: 'steps' }`); only ordering is constrained. Revert to fan-out once the
// vendored runtime fix coordinates the scheduler with the commit-chain (CL-2314).
//
// Bluesky is disabled (CL-2401): its search API fails on every run. It stays
// out of the chain until the auth path is fixed.

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: "intake" }),

    hackernews: sourceStep({
      id: "last30days-fetch-hackernews",
      tool: "hackernews_search",
      after: ["intake"],
    }),

    github: sourceStep({
      id: "last30days-fetch-github",
      tool: "github_activity",
      after: ["hackernews"],
    }),

    web: sourceStep({
      id: "last30days-fetch-web",
      tool: "exa_search",
      after: ["github"],
    }),

    reddit: sourceStep({
      id: "last30days-fetch-reddit",
      tool: "reddit_search",
      after: ["web"],
    }),

    x: sourceStep({
      id: "last30days-fetch-x",
      tool: "x_search",
      after: ["reddit"],
    }),

    youtube: sourceStep({
      id: "last30days-fetch-youtube",
      tool: "youtube_search",
      after: ["x"],
    }),

    // Genuine-reasoning relevance judge (W1.2): scores each candidate's
    // relevance to the topic. Its JSON reply feeds the brief, which applies the
    // scores before ranking. Best-effort — the brief degrades to deterministic
    // entity grounding if the judge output is missing or malformed.
    rerank: inlineInferenceStep({
      id: "last30days-rerank",
      systemPrompt: buildRerankSystemPrompt(),
      input: { from: "steps" },
      after: ["youtube"],
    }),

    brief: deterministicToolStep({
      id: "last30days-build-brief",
      tool: "last30days_workflow_brief",
      input: { from: "steps" },
      after: ["rerank"],
    }),

    write: inlineInferenceStep({
      id: "last30days-write-report",
      systemPrompt: buildWriterSystemPrompt(),
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
        ],
      },
      after: ["brief"],
    }),

    persist: deterministicToolStep({
      id: "last30days-persist-artifact",
      tool: "write_artifact",
      input: {
        merge: [
          { from: "steps.intake.output" },
          { from: "steps.brief.output" },
          { from: "steps.write.output" },
        ],
      },
      argMap: {
        title: { from: "topic" },
        body: { from: "reply" },
        kind: { literal: "research" },
        content: { from: "content" },
        jobLabel: { literal: "Last 30 days research" },
      },
      after: ["write"],
    }),
  },
});
