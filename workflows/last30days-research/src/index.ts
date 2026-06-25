import { awaitSignal, defineWorkflow } from "@intx/workflow";
import { deterministicToolStep, inlineInferenceStep } from "@workbench/agents";
import { buildWriterSystemPrompt } from "./prompts";

export const label = "last30days Research";
export const description =
  "Research the last 30 days of market and community signal, synthesize a cited brief, and save it as an artifact.";
export const kind = "last30days-research";

const sourceSearchInput = { from: "steps.intake.output" } as const;
const sourceQueryArgMap = { query: { from: "query" } } as const;

// The seven source fetches are chained sequentially rather than fanned out in
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

export const workflow = defineWorkflow({
  id: kind,
  trigger: { type: "manual" },
  steps: {
    intake: awaitSignal({ name: "intake" }),

    hackernews: deterministicToolStep({
      id: "last30days-fetch-hackernews",
      tool: "hackernews_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["intake"],
    }),

    github: deterministicToolStep({
      id: "last30days-fetch-github",
      tool: "github_activity",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["hackernews"],
    }),

    web: deterministicToolStep({
      id: "last30days-fetch-web",
      tool: "exa_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["github"],
    }),

    reddit: deterministicToolStep({
      id: "last30days-fetch-reddit",
      tool: "reddit_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["web"],
    }),

    x: deterministicToolStep({
      id: "last30days-fetch-x",
      tool: "x_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["reddit"],
    }),

    youtube: deterministicToolStep({
      id: "last30days-fetch-youtube",
      tool: "youtube_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["x"],
    }),

    bluesky: deterministicToolStep({
      id: "last30days-fetch-bluesky",
      tool: "bluesky_search",
      input: sourceSearchInput,
      argMap: sourceQueryArgMap,
      after: ["youtube"],
    }),

    brief: deterministicToolStep({
      id: "last30days-build-brief",
      tool: "last30days_workflow_brief",
      input: { from: "steps" },
      after: ["bluesky"],
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
      },
      after: ["write"],
    }),
  },
});
